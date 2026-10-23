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
import {applyKnowledgeCatalog, checkFileCopies, deployEmittedModels, deployKnowledgeCatalog, EmittedModel, MAX_ASPECT_DATA_BYTES, preflightKnowledgeCatalog,} from '../../../src/libts/semantic/deploy_knowledge_catalog';
import {semanticLinkId} from '../../../src/libts/semantic/kc_ids';
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
  const r = loadSemanticModels(
      docs, {defaultProject: 'test-project', allowLegacyBareSource: true});
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

// A loader-valid VANILLA (0.2.0.dev0) model. The loader rejects a GOOGLE
// custom_extension whose data is not JSON, so the test that needs one sets it
// on the loaded model, as a model built in memory could carry it. The emitter
// (via googleDeploymentTargets) then throws while building the semantic-model
// aspect.
const VANILLA_SALES = `
version: "0.2.0.dev0"
semantic_model:
  - name: sales
    datasets:
      - name: orders
        source: bigquery.googleapis.com/projects/demo/datasets/sales/tables/orders
        primary_key: [o_orderkey]
        fields:
          - name: o_orderkey
            expression:
              dialects: [{ dialect: BIGQUERY, expression: o_orderkey }]
          - name: o_totalprice
            expression:
              dialects: [{ dialect: BIGQUERY, expression: o_totalprice }]
    metrics:
      - name: total_revenue
        expression:
          dialects: [{ dialect: BIGQUERY, expression: "SUM(orders.o_totalprice)" }]
`;

// entryCreateTries: 1 keeps the propagation-retry loop from sleeping in tests.
const OPTS = {
  project: 'dest',
  location: 'us',
  entryGroup: 'eg',
  entryCreateTries: 1
};
const V2_OPTS = {...OPTS, v2Aspects: true};

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
  // Result of getEntry, which push makes for an entry the listing lacks when
  // create returns 409, keyed by entry id. Default: 200 with no entrySource.
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
    const MIX = 'The catalog may now lack some or all of this push\'s file ' +
        'copies, so push again before you pull.';

    const result = await deployKnowledgeCatalog(models(DOCS), CTX, OPTS);

    expect(result.success).toBe(false);
    expect(result.details).toContain('entry \'sales\': update boom');
    expect(result.details).not.toContain(MIX);

    // With file copies, some or all of this push's copies may be missing
    // after a failed write.
    const withCopies = await deployKnowledgeCatalog(
        models(DOCS), CTX,
        {...OPTS, sourceFiles: [{fileName: 'sales.yaml', content: OSSIE}]});
    expect(withCopies.success).toBe(false);
    expect(withCopies.details)
        .toBe(`Model 'sales': entry 'sales': update boom. ${MIX}`);
  });
});


describe('deployKnowledgeCatalog: the note to push again before a pull', () => {
  const COPIES = [{fileName: 'sales.yaml', content: OSSIE}];

  test('a server message that ends in a period gets no second one', async () => {
    stubClient({
      create: () => err(409, 'entry already exists'),
      update: err(500, 'Internal error encountered.'),
    });

    const result = await deployKnowledgeCatalog(
        models(DOCS), CTX, {...OPTS, sourceFiles: COPIES});

    expect(result.details)
        .toBe(
            'Model \'sales\': entry \'sales\': Internal error encountered. ' +
            'The catalog may now lack some or all of this push\'s file ' +
            'copies, so push again before you pull.');
  });

  // A message that ends in a newline still gets the note on the same line.
  test('a thrown error, such as a network failure, gets the note', async () => {
    for (const message of ['fetch failed', 'fetch failed\n']) {
      mock.restore();
      stubClient({
        create: (entryId) => {
          if (entryId.includes('.files.')) throw new Error(message);
          return ok({});
        },
      });

      const result = await deployKnowledgeCatalog(
          models(DOCS), CTX, {...OPTS, sourceFiles: COPIES});

      expect(result.success).toBe(false);
      expect(result.details)
          .toBe(
              'fetch failed. The catalog may now lack some or all of this ' +
              'push\'s file copies, so push again before you pull.');
    }
  });

  // A rename that stops while removing the old model stores none of this
  // push's copies. Pull may then return the old model, so push says to push
  // again.
  test('a failure removing another model gets the note', async () => {
    stubClient({
      existing: [{id: 'old', type: MODEL_TYPE}],
      del: () => err(500, 'delete boom'),
    });

    const result = await deployKnowledgeCatalog(
        models(DOCS), CTX, {...OPTS, forceRemove: true, sourceFiles: COPIES});

    expect(result.success).toBe(false);
    expect(result.details)
        .toBe(
            'Deleting entry \'old\' from removed model \'old\' failed: ' +
            'delete boom. The catalog may now lack some or all of this ' +
            'push\'s file copies, so push again before you pull.');
  });

  test('a thrown error removing another model gets the note', async () => {
    const {create} = stubClient({
      existing: [{id: 'old', type: MODEL_TYPE}],
      del: () => {
        throw new Error('fetch failed');
      },
    });

    const result = await deployKnowledgeCatalog(
        models(DOCS), CTX, {...OPTS, forceRemove: true, sourceFiles: COPIES});

    expect(result.success).toBe(false);
    expect(result.details)
        .toBe(
            'fetch failed. The catalog may now lack some or all of this ' +
            'push\'s file copies, so push again before you pull.');
    expect(create).not.toHaveBeenCalled();
  });
});


describe('deployKnowledgeCatalog: the push id label and other writers\' fields', () => {
  const PUSH = '6f1c1a0e-4b7d-4c55-9b1e-2a6f8f0d9c3b';
  const COPIES = [{fileName: 'sales.yaml', content: OSSIE, pushId: PUSH}];
  const LABELS = {'kcmd-push-id': PUSH};
  // The entry each write call sent for the model entry `sales`.
  const createdAnchor = (create: any) =>
      create.mock.calls.find((c: any[]) => c[3] === 'sales')![4];
  const updated = (update: any, id: string) => update.mock.calls.find(
      (c: any[]) => c[0].name.endsWith(`/entries/${id}`))!;
  const ENTITY = 'sales.entities.orders';
  // Labels another writer set, beside the label of an earlier push.
  const existing: {id: string; type: string; labels: Record<string, string>}[] =
      [
        {
          id: 'sales',
          type: MODEL_TYPE,
          labels: {'owner': 'data-team', 'kcmd-push-id': 'earlier'},
        },
        {id: ENTITY, type: ENTITY_TYPE, labels: {'owner': 'data-team'}},
      ];
  const exists = () => err(409, 'entry already exists');

  test('a push that stores copies labels the model entry on create and on ' +
           'update',
       async () => {
         const {create} = stubClient();
         expect((await deployKnowledgeCatalog(
                     models(DOCS), CTX, {...OPTS, sourceFiles: COPIES}))
                    .success)
             .toBe(true);
         expect(createdAnchor(create).entrySource.labels).toEqual(LABELS);
         // Only the model entry carries it.
         for (const c of create.mock.calls.filter(c => c[3] !== 'sales')) {
           expect((c[4] as any).entrySource?.labels).toBeUndefined();
         }

         mock.restore();
         const {update} = stubClient({create: exists});
         expect((await deployKnowledgeCatalog(
                     models(DOCS), CTX, {...OPTS, sourceFiles: COPIES}))
                    .success)
             .toBe(true);
         const [entry, mask] = updated(update, 'sales');
         expect(entry.entrySource.labels).toEqual(LABELS);
         // The mask names the entrySource, so Dataplex stores the label.
         expect(mask).toContain('entry_source');
       });

  test('with v2Aspects on, the model entry carries no label', async () => {
    const opts = {...OPTS, sourceFiles: COPIES, v2Aspects: true};
    const {create} = stubClient();
    expect((await deployKnowledgeCatalog(models(DOCS), CTX, opts)).success)
        .toBe(true);
    expect(createdAnchor(create).entrySource.labels).toBeUndefined();

    mock.restore();
    const {update} = stubClient({create: exists});
    expect((await deployKnowledgeCatalog(models(DOCS), CTX, opts)).success)
        .toBe(true);
    const [entry, mask] = updated(update, 'sales');
    expect(entry.entrySource.labels).toBeUndefined();
    expect(mask).toContain('entry_source');
  });

  // The update replaces the whole entrySource, so it carries them over.
  test('a re-push keeps the labels another writer set', async () => {
    const {update} = stubClient({create: exists, existing});
    expect((await deployKnowledgeCatalog(
                models(DOCS), CTX, {...OPTS, sourceFiles: COPIES}))
               .success)
        .toBe(true);
    expect(updated(update, 'sales')[0].entrySource.labels)
        .toEqual({'owner': 'data-team', 'kcmd-push-id': PUSH});
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
    // description, and a file copy sets neither.
    const listed = {
      ...source,
      displayName: 'renamed in console',
      description: 'set by an earlier push',
    };
    const COPY = 'sales.files.sales.yaml';
    const {create, update} = stubClient({
      create: exists,
      existing: [
        {id: 'sales', type: MODEL_TYPE, source: listed},
        {id: ENTITY, type: ENTITY_TYPE, source: listed},
        {id: COPY, type: FILE_TYPE, source: listed},
      ],
    });
    expect((await deployKnowledgeCatalog(
                models(DOCS), CTX, {...OPTS, sourceFiles: COPIES}))
               .success)
        .toBe(true);
    // kcmd's own fields come from the entry it emitted.
    const emitted = (id: string): Record<string, any> =>
        create.mock.calls.find((c: any[]) => c[3] === id)![4]!.entrySource!;
    expect(updated(update, 'sales')[0].entrySource)
        .toEqual({...source, ...emitted('sales')});
    expect(emitted('sales'))
        .toMatchObject({displayName: 'sales', labels: LABELS});
    expect(updated(update, ENTITY)[0].entrySource)
        .toEqual({...source, ...emitted(ENTITY)});
    expect(updated(update, COPY)[0].entrySource).toEqual(source);
  });

  // A listing the caller may not make comes back empty, and another writer
  // can create an entry after the listing.
  test('an entry the listing lacks is read before its update, and its ' +
           'fields are kept',
       async () => {
         const source = {system: 'other-tool', labels: {'owner': 'data-team'}};
         const {getEntry, update} = stubClient({
           create: exists,
           // A listed entry with no entrySource is not read again.
           existing: [{id: ENTITY, type: ENTITY_TYPE}],
           getEntry: (id) => ok(id === 'sales' ? {entrySource: source} : {}),
         });
         expect((await deployKnowledgeCatalog(
                     models(DOCS), CTX, {...OPTS, sourceFiles: COPIES}))
                    .success)
             .toBe(true);
         expect(updated(update, 'sales')[0].entrySource).toEqual({
           system: 'other-tool',
           displayName: 'sales',
           labels: {'owner': 'data-team', ...LABELS},
         });
         // The read keeps the stored resource as it is.
         const read = getEntry.mock.calls.find((c: any[]) => c[3] === 'sales')!;
         expect(read[5]).toEqual({keepSourceResource: true});
         expect(getEntry.mock.calls.map((c: any[]) => c[3]))
             .not.toContain(ENTITY);

         mock.restore();
         stubClient({create: exists, getEntry: () => err(403, 'denied')});
         const failed = await deployKnowledgeCatalog(
             models(DOCS), CTX, {...OPTS, sourceFiles: COPIES});
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

  test('a flag-on push removes only kcmd\'s label', async () => {
    const {update} = stubClient({create: exists, existing});
    expect((await deployKnowledgeCatalog(
                models(DOCS), CTX,
                {...OPTS, sourceFiles: COPIES, v2Aspects: true}))
               .success)
        .toBe(true);
    expect(updated(update, 'sales')[0].entrySource.labels)
        .toEqual({'owner': 'data-team'});
  });
});


describe('checkFileCopies', () => {
  test('two file names that map to one entry id are an error', () => {
    expect(checkFileCopies([
      {fileName: 'sales.profiles/a b.yaml', content: 'x'},
      {fileName: 'sales.profiles/a_b.yaml', content: 'y'},
    ]))
        .toBe(
            'files \'sales.profiles/a b.yaml\' and ' +
            '\'sales.profiles/a_b.yaml\' both map to one entry id; rename ' +
            'one of them');
  });

  // The push id and the copy count are part of the aspect data.
  test('the size counts the push id and the copy count', () => {
    const file = {fileName: 'sales.yaml', content: ''};
    const envelope = JSON.stringify(file).length;
    const stamped = {pushId: 'p'.repeat(36), pushFileCount: 1};
    const content = 'x'.repeat(MAX_ASPECT_DATA_BYTES - envelope);
    expect(checkFileCopies([{...file, content}])).toBeUndefined();
    expect(checkFileCopies([{...file, content, ...stamped}]))
        .toContain('file \'sales.yaml\' is too large to store');
  });
});


describe('deployKnowledgeCatalog: the size of a file copy', () => {
  const LIMIT = 122_880;
  const NAME = 'sales.yaml';
  // The JSON around the content: `{"fileName":"sales.yaml","content":""}`.
  const ENVELOPE = JSON.stringify({fileName: NAME, content: ''}).length;
  const preflight = (content: string) => deployKnowledgeCatalog(
      models(DOCS), CTX,
      {...OPTS, validateOnly: true, sourceFiles: [{fileName: NAME, content}]});

  test('a copy whose JSON is exactly at the limit fits; one byte more fails',
       async () => {
         expect((await preflight('x'.repeat(LIMIT - ENVELOPE))).success)
             .toBe(true);
         const over = await preflight('x'.repeat(LIMIT - ENVELOPE + 1));
         expect(over.success).toBe(false);
         expect(over.details)
             .toBe(
                 `file 'sales.yaml' is too large to store in Knowledge ` +
                 `Catalog: its copy takes ${LIMIT + 1} bytes, and one aspect ` +
                 `holds at most ${LIMIT}.`);
       });

  // 'é' is one UTF-16 unit and two UTF-8 bytes.
  test('the size counts UTF-8 bytes', async () => {
    const content = 'é'.repeat((LIMIT - ENVELOPE) / 2 + 1);
    expect(JSON.stringify({fileName: NAME, content}).length)
        .toBeLessThan(LIMIT);
    expect((await preflight(content)).success).toBe(false);
  });

  // A double quote takes two bytes once escaped.
  test('the size counts the JSON escapes', async () => {
    const content = '"'.repeat((LIMIT - ENVELOPE) / 2 + 1);
    expect(content.length + ENVELOPE).toBeLessThan(LIMIT);
    expect((await preflight(content)).success).toBe(false);
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
    // Reading the link shows it joins this model's two entities. Its
    // references spell the project with the number and its name with the ID.
    const {createLink, updateLink} = stubClient({
      createLink: () => err(409, 'entry link already exists'),
      getLink: ok(gotLinkEntry(
          'sales-orders-to-customer',
          ['sales.entities.orders', 'sales.entities.customer'])),
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

  test(
      'a link the lookup did not return whose endpoints changed is deleted ' +
          'and created again',
      async () => {
        // A read by name finds the model's own link under this ID, joining
        // orders to supplier. Its references are immutable, so an update of
        // its aspect would leave the old endpoints.
        let deleted = false;
        const {createLink, delLink, updateLink} = stubClient({
          createLink: () =>
              deleted ? ok({}) : err(409, 'entry link already exists'),
          getLink: ok(gotLinkEntry(
              'sales-orders-to-customer',
              ['sales.entities.orders', 'sales.entities.supplier'])),
          delLink: () => {
            deleted = true;
            return ok({});
          },
        });

        const result =
            await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

        expect(result.success).toBe(true);
        expect(result.linked).toBe(1);
        expect(result.unlinked).toBe(0);
        expect(delLink.mock.calls.map(c => c[3])).toEqual([
          'sales-orders-to-customer',
        ]);
        expect(createLink).toHaveBeenCalledTimes(2);
        expect(updateLink).not.toHaveBeenCalled();
      });

  test(
      'when creating that link again fails, the error says to push again',
      async () => {
        let deleted = false;
        stubClient({
          createLink: () => deleted ? err(500, 'create failed') :
                                      err(409, 'entry link already exists'),
          getLink: ok(gotLinkEntry(
              'sales-orders-to-customer',
              ['sales.entities.orders', 'sales.entities.supplier'])),
          delLink: () => {
            deleted = true;
            return ok({});
          },
        });

        const result =
            await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

        expect(result.success).toBe(false);
        expect(result.linked).toBe(0);
        expect(result.unlinked).toBe(0);
        expect(result.details)
            .toBe(
                'Model \'sales\': entry link \'sales-orders-to-customer\': ' +
                'create failed (push again to restore the link)');
      });

  test(
      'a thrown error creating that link again says to push again',
      async () => {
        let deleted = false;
        stubClient({
          createLink: () => {
            if (deleted) throw new Error('socket hang up');
            return err(409, 'entry link already exists');
          },
          getLink: ok(gotLinkEntry(
              'sales-orders-to-customer',
              ['sales.entities.orders', 'sales.entities.supplier'])),
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
                'Model \'sales\': entry link \'sales-orders-to-customer\': ' +
                'socket hang up (push again to restore the link)');
      });

  test(
      'a failed update of a link the lookup did not return, whose type and ' +
          'endpoints match, reports the server\'s message',
      async () => {
        // The read showed a link under this ID, so the 403 cannot mean that
        // another link holds the two entries.
        stubClient({
          createLink: () => err(409, 'entry link already exists'),
          getLink: ok(gotLinkEntry(
              'sales-orders-to-customer',
              ['sales.entities.orders', 'sales.entities.customer'])),
          updateLink:
              err(403, 'Permission denied on resource (or it may not exist)'),
        });

        const result =
            await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

        expect(result.success).toBe(false);
        expect(result.details)
            .toBe(
                'Model \'sales\': entry link \'sales-orders-to-customer\': ' +
                'Permission denied on resource (or it may not exist)');
      });

  test(
      'a link under this model\'s link ID that joins one of its entities to ' +
          'an entry of the same ID in another entry group is not changed',
      async () => {
        const got = gotLinkEntry(
            'sales-orders-to-customer',
            ['sales.entities.orders', 'sales.entities.customer']);
        got.entryReferences[1].name =
            'projects/123456789/locations/us/entryGroups/other-eg/entries/' +
            'sales.entities.customer';
        const {delLink, updateLink} = stubClient({
          createLink: () => err(409, 'entry link already exists'),
          getLink: ok(got),
        });

        const result =
            await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

        expect(result.success).toBe(false);
        expect(result.details)
            .toBe(
                'Model \'sales\': entry link \'sales-orders-to-customer\' ' +
                'already exists and references entry ' +
                '\'projects/123456789/locations/us/entryGroups/other-eg/' +
                'entries/sales.entities.customer\' outside this model; ' +
                'rename the relationship or delete the existing link');
        expect(updateLink).not.toHaveBeenCalled();
        expect(delLink).not.toHaveBeenCalled();
      });

  test(
      'a link under this model\'s link ID that joins one of its entities to ' +
          'an entry of the same ID in another project is not changed',
      async () => {
        const got = gotLinkEntry(
            'sales-orders-to-customer',
            ['sales.entities.orders', 'sales.entities.customer']);
        got.entryReferences[1].name =
            entryName('sales.entities.customer', '987654321');
        const {delLink, updateLink} = stubClient({
          createLink: () => err(409, 'entry link already exists'),
          getLink: ok(got),
        });

        const result =
            await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

        expect(result.success).toBe(false);
        expect(result.details)
            .toBe(
                'Model \'sales\': entry link \'sales-orders-to-customer\' ' +
                'already exists and references entry ' +
                '\'projects/987654321/locations/us/entryGroups/eg/entries/' +
                'sales.entities.customer\' outside this model; rename the ' +
                'relationship or delete the existing link');
        expect(updateLink).not.toHaveBeenCalled();
        expect(delLink).not.toHaveBeenCalled();
      });

  test(
      'a 404 on reading the link after a 409 on createEntryLink fails the ' +
          'push because another link holds those endpoints, with no update',
      async () => {
        // No link holds the ID, so the 409 came from another link on the
        // pair. The error carries the create's own text.
        const {createLink, updateLink} = stubClient({
          createLink: () => err(
              409,
              'EntryLink already exists, for the given entry reference and ' +
                  'link type'),
          getLink: err(404, 'EntryLink does not exist.'),
          updateLink: err(403, 'Permission denied on resource'),
        });

        const result =
            await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

        expect(result.success).toBe(false);
        expect(result.linked).toBe(0);
        expect(result.details)
            .toBe(
                'Model \'sales\': failed to create entry link ' +
                '\'sales-orders-to-customer\' because another \'schema-join\' ' +
                'link already connects \'sales.entities.orders\' and ' +
                '\'sales.entities.customer\'; Knowledge Catalog returned: ' +
                'EntryLink already exists, for the given entry reference and ' +
                'link type');
        expect(createLink).toHaveBeenCalledTimes(1);
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
                  '\'sales-orders-to-customer\' failed: ' + read.message);
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
                'Model \'sales\': entry link \'sales-orders-to-customer\': ' +
                'socket hang up');
        expect(updateLink).not.toHaveBeenCalled();
      });

  test(
      'a link of another type under this model\'s link ID is not changed, ' +
          'and the push fails naming its type',
      async () => {
        // Another tool's `related` link joins the model's two entities under
        // the emitted ID. The lookup skips links of other types, and so does
        // the read.
        const related = gotLinkEntry(
            'sales-orders-to-customer',
            ['sales.entities.orders', 'sales.entities.customer']);
        related.entryLinkType =
            'projects/dataplex-types/locations/global/entryLinkTypes/related';
        const {delLink, updateLink} = stubClient({
          existing: [
            {id: 'sales', type: MODEL_TYPE},
            {id: 'sales.entities.orders', type: ENTITY_TYPE},
            {id: 'sales.entities.customer', type: ENTITY_TYPE},
          ],
          links: () => ok([{
            ...related,
            name: 'projects/123456789/locations/us/entryGroups/eg/' +
                'entryLinks/sales-orders-to-customer',
          }]),
          createLink: () =>
              err(409, 'EntryLink with the given id already exists.'),
          getLink: ok(related),
        });

        const result =
            await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

        expect(result.success).toBe(false);
        expect(result.details)
            .toBe(
                'Model \'sales\': entry link \'sales-orders-to-customer\' ' +
                'already exists with link type \'related\'; rename the ' +
                'relationship or delete the existing link');
        expect(delLink).not.toHaveBeenCalled();
        expect(updateLink).not.toHaveBeenCalled();
      });

  test(
      'a link under this model\'s link ID that joins two entries outside ' +
          'the model is not changed, and the push fails naming the link',
      async () => {
        // The lookup cannot return such a link, because it references none
        // of the model's entities.
        const {updateLink} = stubClient({
          createLink: () => err(409, 'entry link already exists'),
          getLink: ok(linkEntry(
              'sales-orders-to-customer', ['tool.a', 'tool.b'], '123456789')),
        });

        const result =
            await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

        expect(result.success).toBe(false);
        expect(result.linked).toBe(0);
        expect(result.details)
            .toBe(
                'Model \'sales\': entry link \'sales-orders-to-customer\' ' +
                'already exists and references entries \'tool.a\' and ' +
                '\'tool.b\' outside this model; rename the relationship or ' +
                'delete the existing link');
        expect(updateLink).not.toHaveBeenCalled();
      });

  test(
      'a hard failure on updateEntryLink fails the push, naming the link',
      async () => {
        stubClient({
          createLink: () => err(409, 'entry link already exists'),
          getLink: ok(gotLinkEntry(
              'sales-orders-to-customer',
              ['sales.entities.orders', 'sales.entities.customer'])),
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
  test('a failed anchor write stops before its children', async () => {
    const {create} = stubClient({
      create: (id) => id === 'sales' ? err(500, 'boom') : ok({}),
    });

    const result = await deployKnowledgeCatalog(models(DOCS), CTX, OPTS);

    expect(result.success).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);  // anchor only; children skipped
  });

  test(
      'a failed child entry write in a batch of two keeps partial created ' +
          'and updated counts',
      async () => {
        // `STAR_DOCS` writes the anchor (`sales`) first, then the two
        // independent entity entries (`sales.entities.orders` and
        // `sales.entities.customer`) concurrently in one batch. Let the anchor
        // be updated in place (409 -> 200), the first entity be created (200),
        // and the second entity fail (500).
        const {create, update} = stubClient({
          create: (id) => {
            if (id === 'sales') return err(409, 'already exists');
            if (id === 'sales.entities.customer') return err(500, 'boom');
            return ok({});
          },
          update: ok({}),
        });

        const result =
            await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

        expect(result.success).toBe(false);
        expect(result.created).toBe(1);  // sales.entities.orders
        expect(result.updated).toBe(1);  // sales (anchor)
        expect(result.details)
            .toBe('Model \'sales\': entry \'sales.entities.customer\': boom');
        expect(create).toHaveBeenCalledTimes(3);  // dependent metrics skipped
        expect(update).toHaveBeenCalledTimes(1);
      });

  test(
      'a model that throws during emit fails with the model + document named',
      async () => {
        // A model whose GOOGLE extension is invalid JSON makes the emitter
        // throw; the publisher must report it, not crash the push.
        const {create} = stubClient();
        const loaded =
            models([{name: 'broken.yaml', text: VANILLA_SALES}]);
        loaded[0].model.customExtensions =
            [{vendorName: 'GOOGLE', data: 'not valid json'}];

        const result = await deployKnowledgeCatalog(loaded, CTX, OPTS);

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
      existing: [...EMITTED, 'sales.entities.removed'],
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
            'sales.entities.removed',
            'sales.metrics.removed',
          ],
          del: (id) =>
              id === 'sales.metrics.removed' ? err(500, 'boom') : ok({}),
        });

        const result = await deployKnowledgeCatalog(models(DOCS), CTX, OPTS);

        expect(result.success).toBe(false);
        expect(result.created).toBe(3);
        expect(result.deleted).toBe(1);
        expect(result.details)
            .toBe(
                'Deleting orphaned entry \'sales.metrics.removed\' from model ' +
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

// A schema-join entry link as lookupEntryLinks returns it: `refIds` are the two
// endpoint entry ids (undirected, both UNSPECIFIED).
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

// A schema-join entry link as getEntryLink returns it. Dataplex spells the
// name as push requested it, with the scope's project 'dest', and the
// references with the project number 123456789.
function gotLinkEntry(id: string, refIds: string[]): any {
  return {
    ...linkEntry(id, refIds, '123456789'),
    name: `projects/dest/locations/us/entryGroups/eg/entryLinks/${id}`,
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
         links: () => ok([orphan, KEPT]),
       });

       const result = await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

       expect(result.success).toBe(true);
       expect(result.unlinked).toBe(1);
       expect(delLink).toHaveBeenCalledTimes(1);
       expect(delLink.mock.calls[0][3]).toBe('sales-orders-to-supplier');
     });

  test(
      'renaming a relationship while keeping its endpoints deletes the old ' +
          'link before creating the new one',
      async () => {
        // Dataplex allows one link per type between two entries: creating the
        // renamed link (`sales-orders-to-customer`) before deleting the old
        // link (`sales-old-orders-to-customer`) between the same two entities
        // returns 409.
        const renamedFrom = linkEntry(
            'sales-old-orders-to-customer',
            ['sales.entities.orders', 'sales.entities.customer'], '123456789');
        let oldDeleted = false;
        const {createLink, delLink, updateLink} = stubClient({
          existing: STAR_ENTITIES,
          links: () => ok([renamedFrom]),
          delLink: (id) => {
            if (id === 'sales-old-orders-to-customer') oldDeleted = true;
            return ok({});
          },
          createLink: () => oldDeleted ?
              ok({}) :
              err(409,
                  'EntryLink already exists, for the given entry reference ' +
                      'and link type'),
        });

        const result =
            await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

        expect(result.success).toBe(true);
        expect(result.unlinked).toBe(1);
        expect(result.linked).toBe(1);
        expect(delLink).toHaveBeenCalledTimes(1);
        expect(delLink.mock.calls[0][3]).toBe('sales-old-orders-to-customer');
        expect(createLink).toHaveBeenCalledTimes(1);
        expect(updateLink).not.toHaveBeenCalled();
      });

  test(
      'when creating a renamed relationship link fails after deleting the ' +
          'old link, the error includes the push-again hint',
      async () => {
        // The lookup spells the old link with the project number and lists
        // its ends in the other order. It still joins the same two entities.
        const renamedFrom = linkEntry(
            'sales-old-orders-to-customer',
            ['sales.entities.customer', 'sales.entities.orders'], '123456789');
        stubClient({
          existing: STAR_ENTITIES,
          links: () => ok([renamedFrom]),
          createLink: () => err(500, 'create failed'),
        });

        const result =
            await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

        expect(result.success).toBe(false);
        expect(result.unlinked).toBe(1);
        expect(result.details)
            .toBe(
                'Model \'sales\': entry link \'sales-orders-to-customer\': ' +
                'create failed (push again to restore the link)');
      });

  test(
      'a failed orphan delete after another orphan\'s delete freed the ' +
          'pair says to push again',
      async () => {
        const renamedFrom = linkEntry(
            'sales-old-orders-to-customer',
            ['sales.entities.orders', 'sales.entities.customer'], '123456789');
        const dropped = linkEntry(
            'sales-orders-to-supplier',
            ['sales.entities.orders', 'sales.entities.supplier']);
        const {createLink} = stubClient({
          existing: STAR_ENTITIES,
          links: () => ok([renamedFrom, dropped]),
          delLink: (id) => id === 'sales-orders-to-supplier' ?
              err(500, 'delete failed') :
              ok({}),
        });

        const result =
            await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

        expect(result.success).toBe(false);
        expect(result.details)
            .toBe(
                'Deleting orphaned entry link \'sales-orders-to-supplier\' ' +
                'from model \'sales\' failed: delete failed (push again to ' +
                'restore the link)');
        expect(createLink).not.toHaveBeenCalled();
      });

  test('a failed delete of a renamed link has no push-again hint', async () => {
    // The old link still joins the pair, so nothing is missing.
    const renamedFrom = linkEntry(
        'sales-old-orders-to-customer',
        ['sales.entities.orders', 'sales.entities.customer']);
    stubClient({
      existing: STAR_ENTITIES,
      links: () => ok([renamedFrom]),
      delLink: () => err(500, 'delete failed'),
    });

    const result = await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

    expect(result.success).toBe(false);
    expect(result.details)
        .toBe(
            'Deleting orphaned entry link \'sales-old-orders-to-customer\' ' +
            'from model \'sales\' failed: delete failed');
  });

  test(
      'an error on a link that no deleted link made way for has no ' +
          'push-again hint',
      async () => {
        // The orphan belongs to a dropped relationship, so no emitted link
        // takes its place. The link whose update fails still exists.
        const orphan = linkEntry(
            'sales-orders-to-supplier',
            ['sales.entities.orders', 'sales.entities.supplier']);
        stubClient({
          existing: STAR_ENTITIES,
          links: () => ok([orphan, KEPT]),
          createLink: () => err(409, 'already exists'),
          updateLink: err(500, 'backend error'),
        });

        const result =
            await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

        expect(result.success).toBe(false);
        expect(result.unlinked).toBe(1);
        expect(result.details)
            .toBe(
                'Model \'sales\': entry link \'sales-orders-to-customer\': ' +
                'backend error');
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

  test(
      'never deletes a link to an entry with one of the model\'s IDs in ' +
          'another entry group or project',
      async () => {
        // Both links are stored in this entry group, so the lookup returns
        // them. Each joins `orders` to an entry outside the group whose entry
        // ID starts with the model's prefix.
        const otherGroup = linkEntry(
            'sales-orders-to-supplier',
            ['sales.entities.orders', 'sales.entities.supplier'], '123456789');
        otherGroup.entryReferences[1].name =
            'projects/123456789/locations/us/entryGroups/other-eg/entries/' +
            'sales.entities.supplier';
        const otherProject = linkEntry(
            'sales-orders-to-warehouse',
            ['sales.entities.orders', 'sales.entities.warehouse'],
            '123456789');
        otherProject.entryReferences[1].name =
            entryName('sales.entities.warehouse', '987654321');
        const {delLink} = stubClient({
          existing: STAR_ENTITIES,
          links: () => ok([otherGroup, otherProject, KEPT]),
        });

        const result =
            await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

        expect(result.success).toBe(true);
        expect(result.unlinked).toBe(0);
        expect(delLink).not.toHaveBeenCalled();
      });

  test(
      'a looked-up link under the model\'s link ID that joins one of its ' +
          'entities to an entry in another entry group fails the push',
      async () => {
        // Its references match the emitted link's entry IDs, but one of them
        // names an entry in another entry group.
        const crossGroup = linkEntry(
            'sales-orders-to-customer',
            ['sales.entities.orders', 'sales.entities.customer'], '123456789');
        crossGroup.entryReferences[1].name =
            'projects/123456789/locations/us/entryGroups/other-eg/entries/' +
            'sales.entities.customer';
        const {delLink, updateLink} = stubClient({
          existing: STAR_ENTITIES,
          links: () => ok([crossGroup]),
          createLink: () => err(409, 'entry link already exists'),
        });

        const result =
            await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

        expect(result.success).toBe(false);
        expect(result.details)
            .toBe(
                'Model \'sales\': entry link \'sales-orders-to-customer\' ' +
                'already exists and references entry ' +
                '\'projects/123456789/locations/us/entryGroups/other-eg/' +
                'entries/sales.entities.customer\' outside this model; ' +
                'rename the relationship or delete the existing link');
        expect(updateLink).not.toHaveBeenCalled();
        expect(delLink).not.toHaveBeenCalled();
      });

  test(
      'a renamed relationship whose new link ID is held by a link outside ' +
          'the model fails before the old link is deleted',
      async () => {
        // The lookup returns the old link only. The read of the new ID, made
        // before any delete, finds a link between two entries outside the
        // model.
        const renamedFrom = linkEntry(
            'sales-old-orders-to-customer',
            ['sales.entities.orders', 'sales.entities.customer'], '123456789');
        const outside = gotLinkEntry(
            'sales-orders-to-customer', ['tool.a', 'tool.b']);
        const {createLink, delLink, updateLink} = stubClient({
          existing: STAR_ENTITIES,
          links: () => ok([renamedFrom]),
          createLink: () => err(409, 'entry link already exists'),
          getLink: ok(outside),
        });

        const result =
            await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

        expect(result.success).toBe(false);
        expect(result.unlinked).toBe(0);
        expect(result.details)
            .toBe(
                'Model \'sales\': entry link \'sales-orders-to-customer\' ' +
                'already exists and references entries \'tool.a\' and ' +
                '\'tool.b\' outside this model; rename the relationship or ' +
                'delete the existing link');
        expect(delLink).not.toHaveBeenCalled();
        expect(createLink).not.toHaveBeenCalled();
        expect(updateLink).not.toHaveBeenCalled();
      });

  test(
      'a thrown read of a new link ID before a link delete names the model ' +
          'and the link, and deletes nothing',
      async () => {
        const renamedFrom = linkEntry(
            'sales-old-orders-to-customer',
            ['sales.entities.orders', 'sales.entities.customer'], '123456789');
        const {delLink} = stubClient({
          existing: STAR_ENTITIES,
          links: () => ok([renamedFrom]),
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
                'Model \'sales\': entry link \'sales-orders-to-customer\': ' +
                'socket hang up');
        expect(delLink).not.toHaveBeenCalled();
      });

  test(
      'a failed read of a new link ID before a link delete gives the read\'s ' +
          'error without saying the link exists, and deletes nothing',
      async () => {
        // No create has run, so nothing shows that a link holds the ID.
        const renamedFrom = linkEntry(
            'sales-old-orders-to-customer',
            ['sales.entities.orders', 'sales.entities.customer'], '123456789');
        const {createLink, delLink} = stubClient({
          existing: STAR_ENTITIES,
          links: () => ok([renamedFrom]),
          getLink: err(503, 'backend unavailable'),
        });

        const result =
            await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

        expect(result.success).toBe(false);
        expect(result.details)
            .toBe(
                'Model \'sales\': reading entry link ' +
                '\'sales-orders-to-customer\' failed: backend unavailable');
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
        const orphanA = linkEntry(
            'sales-orders-to-supplier',
            ['sales.entities.orders', 'sales.entities.supplier']);
        const orphanB = linkEntry(
            'sales-orders-to-warehouse',
            ['sales.entities.orders', 'sales.entities.warehouse']);
        const {createLink, delLink} = stubClient({
          existing: STAR_ENTITIES,
          links: (entry: string) => entry.endsWith('sales.entities.orders') ?
              ok([orphanA, orphanB]) :
              ok([]),
          delLink: (id) =>
              id === 'sales-orders-to-warehouse' ? err(500, 'boom') : ok({}),
        });

        const result =
            await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

        expect(result.success).toBe(false);
        expect(result.created).toBe(5);
        expect(result.linked).toBe(0);
        expect(result.unlinked).toBe(1);
        expect(result.details)
            .toBe(
                'Deleting orphaned entry link \'sales-orders-to-warehouse\' ' +
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
         const own = linkEntry(
             'sales-orders-to-customer',
             ['sales.entities.orders', 'sales.entities.customer'], '777');
         const {getProject} = stubClient({
           existing: [
             {id: 'old', type: MODEL_TYPE},
             {id: 'old.entities.a', type: ENTITY_TYPE},
             {id: 'old.entities.b', type: ENTITY_TYPE},
             {id: 'sales', type: MODEL_TYPE},
             {id: 'sales.entities.orders', type: ENTITY_TYPE},
             {id: 'sales.entities.customer', type: ENTITY_TYPE},
           ],
           existingProject: project,
           links: (entry: string) =>
               entry.includes('old.entities.') ? ok([oldLink]) : ok([own]),
           createLink: () => err(409, 'already exists'),
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

  describe('the omitted model\'s file copies', () => {
    const EXISTING = [
      {id: 'old', type: MODEL_TYPE},
      {id: 'old.entities.a', type: ENTITY_TYPE},
      {id: 'old.files.old.yaml', type: FILE_TYPE},
      {id: 'old.files.old.profile.prod.yaml', type: FILE_TYPE},
    ];

    test('are deleted after its anchor', async () => {
      const {del} = stubClient({existing: EXISTING});

      const result = await deployKnowledgeCatalog(
          models(DOCS), CTX, {...OPTS, forceRemove: true});

      expect(result.success).toBe(true);
      expect(result.deleted).toBe(4);
      expect(del.mock.calls.map(c => c[3])).toEqual([
        'old', 'old.entities.a', 'old.files.old.yaml',
        'old.files.old.profile.prod.yaml'
      ]);
    });

    // Nothing else of the model is deleted either, so pull still finds it
    // whole, with its files.
    test('are kept when deleting its anchor fails', async () => {
      const {del, delLink, create} = stubClient({
        existing: EXISTING,
        del: (entryId) => entryId === 'old' ? err(500, 'delete boom') : ok({}),
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


describe('deployKnowledgeCatalog: the file-copy type lookup', () => {
  const COPIES = [{fileName: 'commerce.yaml', content: ACTIONS_DOC}];

  test('a caller that has not checked the type gets it looked up', async () => {
    const {getEntryType, getAspectType} = stubClient();

    const result = await deployKnowledgeCatalog(
        models(ACTIONS_DOCS), CTX, {...OPTS, sourceFiles: COPIES});

    expect(result.success).toBe(true);
    for (const spy of [getEntryType, getAspectType]) {
      expect(spy.mock.calls.map(c => c[2]).sort())
          .toEqual(['semantic-action', 'semantic-model-file']);
    }
  });

  test('a caller that has checked it gets only the other types looked up',
       async () => {
         const {getEntryType, getAspectType} = stubClient();

         const result = await deployKnowledgeCatalog(
             models(ACTIONS_DOCS), CTX,
             {...OPTS, sourceFiles: COPIES, fileCopyTypeChecked: true});

         expect(result.success).toBe(true);
         for (const spy of [getEntryType, getAspectType]) {
           expect(spy.mock.calls.map(c => c[2])).toEqual(['semantic-action']);
         }
       });
});


describe('deployKnowledgeCatalog: file copies on a re-push', () => {
  // A copy lives under the model's `.files.` prefix, so the model owns it. A
  // copy is not an entity, so no link lookup goes through it.
  test('keeps the copy it stores again, deletes the copy of a removed file, ' +
           'and looks up links only through entities',
       async () => {
         const kept = linkEntry(
             'sales-orders-to-customer',
             ['sales.entities.orders', 'sales.entities.customer']);
         const {del, lookupLinks, delLink} = stubClient({
           existing: [
             {id: 'sales', type: MODEL_TYPE},
             {id: 'sales.entities.orders', type: ENTITY_TYPE},
             {id: 'sales.entities.customer', type: ENTITY_TYPE},
             {id: 'sales.files.star.yaml', type: FILE_TYPE},
             {id: 'sales.files.star.profile.prod.yaml', type: FILE_TYPE},
           ],
           links: () => ok([kept]),
         });

         const result = await deployKnowledgeCatalog(
             models(STAR_DOCS), CTX,
             {...OPTS, sourceFiles: [{fileName: 'star.yaml', content: STAR}]});

         expect(result.success).toBe(true);
         expect(lookupLinks.mock.calls.map(c => (c[2] as any).entry).sort())
             .toEqual([
               entryName('sales.entities.customer'),
               entryName('sales.entities.orders'),
             ]);
         expect(delLink).not.toHaveBeenCalled();
         expect(del.mock.calls.map(c => c[3])).toEqual([
           'sales.files.star.profile.prod.yaml',
         ]);
         expect(result.deleted).toBe(1);
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
      'with v2Aspects on, updating model, entity, metric, and action ' +
          'entries passes the exact V2 aspectKeys list and ' +
          'deleteMissingAspects: true',
      async () => {
        // Force every `createEntry` call to return 409 ALREADY_EXISTS so
        // `writeEntry` falls back to `updateEntry`.
        const {update} = stubClient({
          create: () => err(409, 'already exists'),
          update: ok({}),
        });

        const salesResult = await deployKnowledgeCatalog(
            models(DOCS), CTX, {...OPTS, v2Aspects: true});
        const actionsResult = await deployKnowledgeCatalog(
            models(ACTIONS_DOCS), CTX, {...OPTS, v2Aspects: true});

        expect(salesResult.success).toBe(true);
        expect(actionsResult.success).toBe(true);

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

        expect(
            entityUpdateCall![0]
                .aspects?.['dataplex-types.global.sql-expressions'])
            .toBeUndefined();

        expect(modelUpdateCall![2]).toEqual([
          'dataplex-types.global.semantic-model',
          'dataplex-types.global.guidelines',
          'dataplex-types.global.semantic-extensions',
        ]);
        expect(modelUpdateCall![3]).toBe(true);

        expect(entityUpdateCall![2]).toEqual([
          'dataplex-types.global.semantic-entity',
          'dataplex-types.global.schema',
          'dataplex-types.global.guidelines',
          'dataplex-types.global.semantic-extensions',
          'dataplex-types.global.sql-expressions',
          'dataplex-types.global.guidelines@*',
        ]);
        expect(entityUpdateCall![3]).toBe(true);

        expect(metricUpdateCall![2]).toEqual([
          'dataplex-types.global.semantic-metric',
          'dataplex-types.global.sql-expressions',
          'dataplex-types.global.guidelines',
          'dataplex-types.global.semantic-extensions',
        ]);
        expect(metricUpdateCall![3]).toBe(true);

        expect(actionUpdateCall![2]).toEqual([
          'dest.global.semantic-action',
          'dataplex-types.global.guidelines',
        ]);
        expect(actionUpdateCall![3]).toBe(true);
      });

  test(
      'with v2Aspects off, updating model, entity, metric, and action ' +
          'entries passes the exact V1 aspectKeys list and ' +
          'deleteMissingAspects: true',
      async () => {
        const {update} = stubClient({
          create: () => err(409, 'already exists'),
          update: ok({}),
        });

        const salesResult =
            await deployKnowledgeCatalog(models(DOCS), CTX, OPTS);
        const actionsResult =
            await deployKnowledgeCatalog(models(ACTIONS_DOCS), CTX, OPTS);

        expect(salesResult.success).toBe(true);
        expect(actionsResult.success).toBe(true);

        const modelUpdateCall = update.mock.calls.find(
            c => (c[0].name as string).endsWith('/entries/sales'));
        const entityUpdateCall = update.mock.calls.find(
            c => (c[0].name as string).endsWith('sales.entities.orders'));
        const metricUpdateCall = update.mock.calls.find(
            c => (c[0].name as string).endsWith('sales.metrics.total_revenue'));
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
        ]);
        expect(modelUpdateCall![3]).toBe(true);

        expect(entityUpdateCall![2]).toEqual([
          'dataplex-types.global.semantic-entity',
          'dataplex-types.global.schema',
          'dataplex-types.global.guidelines',
        ]);
        expect(entityUpdateCall![3]).toBe(true);

        expect(metricUpdateCall![2]).toEqual([
          'dataplex-types.global.semantic-metric',
          'dataplex-types.global.guidelines',
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
    'deployKnowledgeCatalog: link recreation when type or references change',
    () => {
      test(
          'a relationship that keeps its name and changes an endpoint, ' +
              'flag off, has its link deleted and created again',
          async () => {
            // The existing link in the entry group under the same ID
            // (`sales-orders-to-customer`) previously pointed at
            // `sales.entities.supplier` instead of `sales.entities.customer`,
            // and the server spells the project by number ('123456789').
            const staleEndpointLink = linkEntry(
                'sales-orders-to-customer',
                ['sales.entities.orders', 'sales.entities.supplier'],
                '123456789');
            const callOrder: string[] = [];
            const {createLink, updateLink, delLink} = stubClient({
              existing: [
                {id: 'sales', type: MODEL_TYPE},
                {id: 'sales.entities.orders', type: ENTITY_TYPE},
                {id: 'sales.entities.customer', type: ENTITY_TYPE},
                {id: 'sales.entities.supplier', type: ENTITY_TYPE},
              ],
              links: () => ok([staleEndpointLink]),
              createLink: (id) => {
                callOrder.push(`createLink:${id}`);
                return ok({});
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
            expect(result.linked).toBe(1);
            expect(delLink).toHaveBeenCalledTimes(1);
            expect(delLink.mock.calls[0][3]).toBe('sales-orders-to-customer');
            expect(createLink).toHaveBeenCalledTimes(1);
            expect((createLink.mock.calls[0][4] as any)
                       .entryReferences.map((r: any) => r.name))
                .toEqual([
                  entryName('sales.entities.orders'),
                  entryName('sales.entities.customer'),
                ]);
            expect(callOrder).toEqual([
              'delLink:sales-orders-to-customer',
              'createLink:sales-orders-to-customer',
              'delEntry:sales.entities.supplier',
            ]);
            expect(updateLink).not.toHaveBeenCalled();
          });

      test(
          'deletes and recreates an existing link when its link type ' +
              'changed even if endpoint references match',
          async () => {
            // Stage an existing `semantic-link` link whose `entryReferences`
            // already match the V1 `schema-join` link emitted by `STAR_DOCS`.
            // Because `entryLinkType` is immutable in Dataplex, the link must
            // still be deleted and recreated.
            const sameRefsWrongType = {
              ...linkEntry(
                  'sales-orders-to-customer',
                  ['sales.entities.orders', 'sales.entities.customer']),
              entryLinkType: SEMANTIC_LINK_TYPE,
            };
            const {createLink, updateLink, delLink} = stubClient({
              existing: [
                {id: 'sales', type: MODEL_TYPE},
                {id: 'sales.entities.orders', type: ENTITY_TYPE},
                {id: 'sales.entities.customer', type: ENTITY_TYPE},
              ],
              links: () => ok([sameRefsWrongType]),
              createLink: () => ok({}),
            });

            const result =
                await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

            expect(result.success).toBe(true);
            expect(result.linked).toBe(1);
            expect(delLink).toHaveBeenCalledTimes(1);
            expect(delLink.mock.calls[0][3]).toBe('sales-orders-to-customer');
            expect(createLink).toHaveBeenCalledTimes(1);
            expect(updateLink).not.toHaveBeenCalled();
          });

      test(
          'updates an existing link in place without deleting when its ' +
              'endpoint references match',
          async () => {
            // Dataplex returns project numbers in server-side resource names,
            // whereas the emitted link carries the project ID ('dest').
            const matchingLink = linkEntry(
                'sales-orders-to-customer',
                ['sales.entities.orders', 'sales.entities.customer'],
                '123456789');
            const {createLink, updateLink, delLink} = stubClient({
              existing: [
                {id: 'sales', type: MODEL_TYPE},
                {id: 'sales.entities.orders', type: ENTITY_TYPE},
                {id: 'sales.entities.customer', type: ENTITY_TYPE},
              ],
              links: () => ok([matchingLink]),
              createLink: () => err(409, 'already exists'),
              updateLink: ok({}),
            });

            const result =
                await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

            expect(result.success).toBe(true);
            expect(result.linked).toBe(1);
            expect(createLink).toHaveBeenCalledTimes(1);
            expect(updateLink).toHaveBeenCalledTimes(1);
            expect(delLink).not.toHaveBeenCalled();
          });

      test(
          'a schema-join link whose references come back in the opposite ' +
              'order still matches and is updated in place',
          async () => {
            const reversedLink = linkEntry(
                'sales-orders-to-customer',
                ['sales.entities.customer', 'sales.entities.orders']);
            const {createLink, updateLink, delLink} = stubClient({
              existing: [
                {id: 'sales', type: MODEL_TYPE},
                {id: 'sales.entities.orders', type: ENTITY_TYPE},
                {id: 'sales.entities.customer', type: ENTITY_TYPE},
              ],
              links: () => ok([reversedLink]),
              createLink: () => err(409, 'already exists'),
              updateLink: ok({}),
            });

            const result =
                await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

            expect(result.success).toBe(true);
            expect(result.linked).toBe(1);
            expect(createLink).toHaveBeenCalledTimes(1);
            expect(updateLink).toHaveBeenCalledTimes(1);
            expect(delLink).not.toHaveBeenCalled();
          });

      test(
          'a link that lookupEntryLinks does not return is updated in place',
          async () => {
            const {createLink, updateLink, delLink} = stubClient({
              existing: [
                {id: 'sales', type: MODEL_TYPE},
                {id: 'sales.entities.orders', type: ENTITY_TYPE},
                {id: 'sales.entities.customer', type: ENTITY_TYPE},
              ],
              links: () => ok([]),
              createLink: () => err(409, 'already exists'),
              getLink: ok(gotLinkEntry(
                  'sales-orders-to-customer',
                  ['sales.entities.orders', 'sales.entities.customer'])),
              updateLink: ok({}),
            });

            const result =
                await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

            expect(result.success).toBe(true);
            expect(result.linked).toBe(1);
            expect(createLink).toHaveBeenCalledTimes(1);
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
            const matchingLink = linkEntry(
                'sales-orders-to-customer',
                ['sales.entities.orders', 'sales.entities.customer'],
                '123456789');
            stubClient({
              existing: [
                {id: 'sales', type: MODEL_TYPE},
                {id: 'sales.entities.orders', type: ENTITY_TYPE},
                {id: 'sales.entities.customer', type: ENTITY_TYPE},
              ],
              links: () => ok([matchingLink]),
              createLink: () => err(409, 'already exists'),
              updateLink:
                  err(403, 'Permission denied on resource (or it may not exist)'),
            });

            const result =
                await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

            expect(result.success).toBe(false);
            expect(result.details)
                .toBe(
                    'Model \'sales\': entry link \'sales-orders-to-customer\': ' +
                    'Permission denied on resource (or it may not exist)');
          });

      test(
          'a 409 on creating the ID of a deleted stale link blames another ' +
              'link and says to push again',
          async () => {
            // The push deletes the stale link, so its ID has no link when the
            // create returns 409, and the read returns 404. Another link holds
            // the new endpoints.
            const staleLink = linkEntry(
                'sales-orders-to-customer',
                ['sales.entities.orders', 'sales.entities.supplier']);
            stubClient({
              existing: [
                {id: 'sales', type: MODEL_TYPE},
                {id: 'sales.entities.orders', type: ENTITY_TYPE},
                {id: 'sales.entities.customer', type: ENTITY_TYPE},
              ],
              links: () => ok([staleLink]),
              createLink: () => err(409, 'already exists'),
            });

            const result =
                await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

            expect(result.success).toBe(false);
            expect(result.details)
                .toBe(
                    'Model \'sales\': failed to create entry link ' +
                    '\'sales-orders-to-customer\' because another ' +
                    '\'schema-join\' link already connects ' +
                    '\'sales.entities.orders\' and \'sales.entities.customer\'; ' +
                    'Knowledge Catalog returned: already exists (push again to ' +
                    'restore the link)');
          });

      test(
          'a link with a reference outside the model is not deleted, and ' +
              'the push fails naming the link before any orphan is deleted',
          async () => {
            const foreignRefLink = linkEntry(
                'sales-orders-to-customer',
                ['sales.entities.orders', 'other.entities.customer']);
            const orphan = linkEntry(
                'sales-orders-to-supplier',
                ['sales.entities.orders', 'sales.entities.supplier']);
            const {createLink, updateLink, delLink} = stubClient({
              existing: [
                {id: 'sales', type: MODEL_TYPE},
                {id: 'sales.entities.orders', type: ENTITY_TYPE},
                {id: 'sales.entities.customer', type: ENTITY_TYPE},
              ],
              links: () => ok([foreignRefLink, orphan]),
            });

            const result =
                await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

            expect(result.success).toBe(false);
            expect(result.details)
                .toBe(
                    'Model \'sales\': entry link \'sales-orders-to-customer\' ' +
                    'already exists and references entry ' +
                    '\'other.entities.customer\' outside this model; rename ' +
                    'the relationship or delete the existing link');
            expect(delLink).not.toHaveBeenCalled();
            expect(updateLink).not.toHaveBeenCalled();
            expect(createLink).not.toHaveBeenCalled();
          });

      test(
          'returns an error when deleting a link with changed references fails',
          async () => {
            const staleDottedLink = linkEntry(
                STAR_SEMANTIC_LINK,
                ['sales.entities.orders', 'sales.entities.customer']);
            const {createLink} = stubClient({
              existing: [
                {id: 'sales', type: MODEL_TYPE},
                {id: 'sales.entities.orders', type: ENTITY_TYPE},
                {id: 'sales.entities.customer', type: ENTITY_TYPE},
              ],
              links: () => ok([staleDottedLink]),
              delLink: () => err(500, 'delete failed'),
            });

            const result = await deployKnowledgeCatalog(
                models(STAR_DOCS), CTX, {...OPTS, v2Aspects: true});

            expect(result.success).toBe(false);
            expect(result.details)
                .toBe(
                    'Deleting stale entry link ' +
                    `'${STAR_SEMANTIC_LINK}' from model 'sales' ` +
                    'failed: delete failed');
            expect(createLink).not.toHaveBeenCalled();
          });

      test(
          'a failed stale link delete after the delete of a renamed ' +
              'relationship\'s link says to push again',
          async () => {
            // `sales-old-orders-to-customer` joins the entities that the
            // emitted `sales-orders-to-customer` joins, so the push deletes it
            // to make way. The push then stops before writing the new link.
            const renamedFrom = linkEntry(
                'sales-old-orders-to-customer',
                ['sales.entities.orders', 'sales.entities.customer']);
            const staleLink = linkEntry(
                'sales-orders-to-customer',
                ['sales.entities.orders', 'sales.entities.supplier']);
            const {createLink} = stubClient({
              existing: [
                {id: 'sales', type: MODEL_TYPE},
                {id: 'sales.entities.orders', type: ENTITY_TYPE},
                {id: 'sales.entities.customer', type: ENTITY_TYPE},
              ],
              links: () => ok([renamedFrom, staleLink]),
              delLink: (id) => id === 'sales-orders-to-customer' ?
                  err(500, 'delete failed') :
                  ok({}),
            });

            const result =
                await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

            expect(result.success).toBe(false);
            expect(result.unlinked).toBe(1);
            expect(result.details)
                .toBe(
                    'Deleting stale entry link ' +
                    '\'sales-orders-to-customer\' from model \'sales\' ' +
                    'failed: delete failed (push again to restore the link)');
            expect(createLink).not.toHaveBeenCalled();
          });

      test(
          'a thrown error on a link delete after an earlier delete in the ' +
              'same batch names the link, keeps the count and says to push ' +
              'again',
          async () => {
            // The first orphan is a renamed relationship's old link, so its
            // delete leaves the pair without a link.
            const renamedFrom = linkEntry(
                'sales-old-orders-to-customer',
                ['sales.entities.orders', 'sales.entities.customer']);
            const dropped = linkEntry(
                'sales-orders-to-supplier',
                ['sales.entities.orders', 'sales.entities.supplier']);
            stubClient({
              existing: [
                {id: 'sales', type: MODEL_TYPE},
                {id: 'sales.entities.orders', type: ENTITY_TYPE},
                {id: 'sales.entities.customer', type: ENTITY_TYPE},
              ],
              links: () => ok([renamedFrom, dropped]),
              delLink: (id) => {
                if (id === 'sales-orders-to-supplier') {
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
                    '\'sales-orders-to-supplier\' from model \'sales\' ' +
                    'failed: socket hang up (push again to restore the link)');
          });

      test(
          'returns an error when recreating a link after deletion fails',
          async () => {
            const staleDottedLink = linkEntry(
                STAR_SEMANTIC_LINK,
                ['sales.entities.orders', 'sales.entities.customer']);
            stubClient({
              existing: [
                {id: 'sales', type: MODEL_TYPE},
                {id: 'sales.entities.orders', type: ENTITY_TYPE},
                {id: 'sales.entities.customer', type: ENTITY_TYPE},
              ],
              links: () => ok([staleDottedLink]),
              delLink: () => err(404, 'already gone'),
              createLink: () => err(500, 'recreate failed'),
            });

            const result = await deployKnowledgeCatalog(
                models(STAR_DOCS), CTX, {...OPTS, v2Aspects: true});

            expect(result.success).toBe(false);
            expect(result.details)
                .toBe(
                    'Model \'sales\': entry link ' +
                    `'${STAR_SEMANTIC_LINK}': recreate failed ` +
                    '(push again to restore the link)');
          });

      test(
          'an error on one link after another replaced a deleted link has ' +
              'no push-again hint',
          async () => {
            // `sales-old-a` joins the pair `sales-a` takes, and `sales-a` is
            // written. The update of `sales-b` fails, and that link still
            // exists.
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
                linkB,
              ]),
              createLink: (id) =>
                  id === 'sales-b' ? err(409, 'already exists') : ok({}),
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

      test(
          'two relationships that swap entity pairs have both stale links ' +
              'deleted before either new link is created',
          async () => {
            const swapDoc = `
version: "0.2.0.dev0"
semantic_model:
  - name: sales
    datasets:
      - name: orders
        source: bigquery.googleapis.com/projects/demo/datasets/sales/tables/orders
        primary_key: [o_orderkey]
        fields:
          - name: o_orderkey
            expression:
              dialects: [{ dialect: BIGQUERY, expression: o_orderkey }]
          - name: o_custkey
            expression:
              dialects: [{ dialect: BIGQUERY, expression: o_custkey }]
          - name: o_suppkey
            expression:
              dialects: [{ dialect: BIGQUERY, expression: o_suppkey }]
      - name: customer
        source: bigquery.googleapis.com/projects/demo/datasets/sales/tables/customer
        primary_key: [c_custkey]
        fields:
          - name: c_custkey
            expression:
              dialects: [{ dialect: BIGQUERY, expression: c_custkey }]
      - name: supplier
        source: bigquery.googleapis.com/projects/demo/datasets/sales/tables/supplier
        primary_key: [s_suppkey]
        fields:
          - name: s_suppkey
            expression:
              dialects: [{ dialect: BIGQUERY, expression: s_suppkey }]
    relationships:
      - name: rel_a
        from: orders
        to: customer
        from_columns: [o_custkey]
        to_columns: [c_custkey]
      - name: rel_b
        from: orders
        to: supplier
        from_columns: [o_suppkey]
        to_columns: [s_suppkey]
`;
            // Previously, `rel_a` connected orders <-> supplier and `rel_b`
            // connected orders <-> customer (the opposite pairs).
            const oldRelA = linkEntry(
                'sales-rel-a',
                ['sales.entities.orders', 'sales.entities.supplier']);
            const oldRelB = linkEntry(
                'sales-rel-b',
                ['sales.entities.orders', 'sales.entities.customer']);
            const callOrder: string[] = [];
            const {createLink, delLink, updateLink} = stubClient({
              existing: [
                {id: 'sales', type: MODEL_TYPE},
                {id: 'sales.entities.orders', type: ENTITY_TYPE},
                {id: 'sales.entities.customer', type: ENTITY_TYPE},
                {id: 'sales.entities.supplier', type: ENTITY_TYPE},
              ],
              links: () => ok([oldRelA, oldRelB]),
              delLink: (id) => {
                callOrder.push(`delLink:${id}`);
                return ok({});
              },
              createLink: (id) => {
                callOrder.push(`createLink:${id}`);
                return ok({});
              },
            });

            const result = await deployKnowledgeCatalog(
                models([{name: 'swap.yaml', text: swapDoc}]), CTX, OPTS);

            expect(result.success).toBe(true);
            expect(result.linked).toBe(2);
            expect(result.unlinked).toBe(0);
            expect(delLink).toHaveBeenCalledTimes(2);
            expect(createLink).toHaveBeenCalledTimes(2);
            expect(updateLink).not.toHaveBeenCalled();
            expect(callOrder).toEqual([
              'delLink:sales-rel-a',
              'delLink:sales-rel-b',
              'createLink:sales-rel-a',
              'createLink:sales-rel-b',
            ]);
          });
    });


describe('deployKnowledgeCatalog: both relationship link types', () => {
  // The STAR model's anchor and entity entries, as a re-push finds them.
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
      'looks up links only through entity entries, skipping model and ' +
          'metric entries',
      async () => {
        const {lookupLinks} = stubClient({
          existing: [
            {id: 'sales', type: MODEL_TYPE},
            {id: 'sales.entities.orders', type: ENTITY_TYPE},
            {id: 'sales.entities.customer', type: ENTITY_TYPE},
            {id: 'sales.metrics.total_revenue', type: METRIC_TYPE},
            {id: 'sales.metrics.order_count', type: METRIC_TYPE},
          ],
        });

        const result =
            await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

        expect(result.success).toBe(true);
        expect(lookupLinks.mock.calls.map(c => c[2])).toEqual([
          {entry: entryName('sales.entities.orders')},
          {entry: entryName('sales.entities.customer')},
        ]);
      });

  test(
      'lookupEntryLinks skips relationship links stored in a sibling entry ' +
          'group',
      async () => {
        // A relationship link created in a sibling entry group (`other-eg`)
        // that references this model's entities must not shadow the model's
        // own link on update or be treated as an orphan to delete in `eg`.
        const siblingSameIdLink = {
          ...linkEntry(
              'sales-orders-to-customer',
              ['sales.entities.orders', 'other.entities.external']),
          name: 'projects/123456789/locations/us/entryGroups/other-eg/' +
              'entryLinks/sales-orders-to-customer',
          entryReferences: [
            {
              name: entryName('sales.entities.orders', '123456789'),
              type: 'UNSPECIFIED',
            },
            {
              name: 'projects/123456789/locations/us/entryGroups/other-eg/' +
                  'entries/other.entities.external',
              type: 'UNSPECIFIED',
            },
          ],
        };
        const siblingOrphanCandidate = {
          ...linkEntry(
              'sales-sibling-link',
              ['sales.entities.orders', 'sales.entities.customer']),
          name: 'projects/123456789/locations/us/entryGroups/other-eg/' +
              'entryLinks/sales-sibling-link',
          entryReferences: [
            {
              name: entryName('sales.entities.orders', '123456789'),
              type: 'UNSPECIFIED',
            },
            {
              name: 'projects/123456789/locations/us/entryGroups/other-eg/' +
                  'entries/sales.entities.customer',
              type: 'UNSPECIFIED',
            },
          ],
        };
        const {createLink, updateLink, delLink} = stubClient({
          existing: [
            {id: 'sales', type: MODEL_TYPE},
            {id: 'sales.entities.orders', type: ENTITY_TYPE},
            {id: 'sales.entities.customer', type: ENTITY_TYPE},
          ],
          links: () => ok([siblingSameIdLink, siblingOrphanCandidate]),
          createLink: () => err(409, 'already exists'),
          getLink: ok(gotLinkEntry(
              'sales-orders-to-customer',
              ['sales.entities.orders', 'sales.entities.customer'])),
          updateLink: ok({}),
        });

        const result =
            await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

        expect(result.success).toBe(true);
        expect(result.linked).toBe(1);
        expect(result.unlinked).toBe(0);
        expect(createLink).toHaveBeenCalledTimes(1);
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
      'with Resource Manager denied, a read link whose references spell a ' +
          'project number fails the push, saying the number could not be ' +
          'found',
      async () => {
        // The listing spells the project as requested, so it gives no number.
        // The second reference names an entry of the same ID in another
        // project, and push cannot tell the two numbers apart.
        const project = 'unresolved-proj';
        const name = (p: string, kind: string, id: string) =>
            `projects/${p}/locations/us/entryGroups/eg/${kind}/${id}`;
        const got = {
          ...linkEntry('sales-orders-to-customer', []),
          name: name(project, 'entryLinks', 'sales-orders-to-customer'),
          entryReferences: [
            {name: name('555', 'entries', 'sales.entities.orders')},
            {name: name('987', 'entries', 'sales.entities.customer')},
          ],
        };
        const {updateLink, delLink, getProject} = stubClient({
          existing: [{id: 'sales', type: MODEL_TYPE}],
          existingProject: project,
          project: () => err(403, 'Permission denied'),
          createLink: () => err(409, 'entry link already exists'),
          getLink: ok(got),
        });

        const result = await deployKnowledgeCatalog(
            models(STAR_DOCS), CTX, {...OPTS, project});

        expect(result.success).toBe(false);
        expect(result.details)
            .toBe(
                'Model \'sales\': entry link \'sales-orders-to-customer\' ' +
                'already exists, and push could not get the number of ' +
                'project \'unresolved-proj\' from Cloud Resource Manager to ' +
                'check its references; check that the caller has ' +
                'resourcemanager.projects.get on the project');
        expect(getProject).toHaveBeenCalledTimes(1);
        expect(updateLink).not.toHaveBeenCalled();
        expect(delLink).not.toHaveBeenCalled();
      });

  test(
      'a Resource Manager outage on the read path gets a message that does ' +
          'not blame a missing permission alone',
      async () => {
        const project = 'outage-proj';
        const got = {
          ...linkEntry('sales-orders-to-customer', []),
          name: `projects/${project}/locations/us/entryGroups/eg/entryLinks/` +
              'sales-orders-to-customer',
          entryReferences: [
            {name: entryName('sales.entities.orders', '999031')},
            {name: entryName('sales.entities.customer', '999031')},
          ],
        };
        const {updateLink} = stubClient({
          createLink: () => err(409, 'entry link already exists'),
          getLink: ok(got),
          project: () => err(503, 'The service is currently unavailable.'),
        });

        const result = await deployKnowledgeCatalog(
            models(STAR_DOCS), CTX, {...OPTS, project});

        expect(result.success).toBe(false);
        expect(result.details).toContain(
            'could not get the number of project \'outage-proj\' from Cloud ' +
            'Resource Manager');
        expect(result.details).not.toContain('needs');
        expect(updateLink).not.toHaveBeenCalled();
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
  // `assignment` joins `employee` to `department` and publishes the link
  // `hr-assignment`.
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

  const HR_WARNINGS = ['previous_department', 'requested_department'].map(
      name => `[hr] relationship '${name}': no join columns, so it is not ` +
          'published to Knowledge Catalog yet; add its from_columns and ' +
          'to_columns to the relationship in the model to publish the link.');

  test('validateOnly warns about each one and plans no link for it',
       async () => {
         const {list, create, createLink} = stubClient();

         const result = await deployKnowledgeCatalog(
             models(HR_DOCS), CTX, {...OPTS, validateOnly: true});

         expect(result.success).toBe(true);
         expect(result.warnings).toEqual(HR_WARNINGS);
         expect(result.plan).toContain('  1 schema-join link:');
         expect(result.plan).toContain('    - hr-assignment');
         expect(list).not.toHaveBeenCalled();
         expect(create).not.toHaveBeenCalled();
         expect(createLink).not.toHaveBeenCalled();
       });

  test('a push skips it and writes every other link', async () => {
    const {createLink} = stubClient();

    const result = await deployKnowledgeCatalog(models(HR_DOCS), CTX, OPTS);

    expect(result.success).toBe(true);
    expect(result.warnings).toEqual(HR_WARNINGS);
    expect(result.linked).toBe(1);
    expect(createLink.mock.calls.map(c => c[3])).toEqual(['hr-assignment']);
  });

  test('a push passes the warnings to onWarnings before the first write',
       async () => {
         const events: string[] = [];
         stubClient({
           create: (id) => {
             events.push(`create:${id}`);
             return ok({});
           },
         });

         const result = await deployKnowledgeCatalog(models(HR_DOCS), CTX, {
           ...OPTS,
           onWarnings: (warnings) => events.push(...warnings),
         });

         expect(result.success).toBe(true);
         expect(events.slice(0, 3)).toEqual([...HR_WARNINGS, 'create:hr']);
       });

  test('deployEmittedModels also passes them before the first write',
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
      'pushing with v2Aspects: true into an entry group holding V1 entries ' +
          'and schema-join links creates V2 entries and links and deletes ' +
          'old V1 entries and links',
      async () => {
        // The entry group holds the five V1 dotted entries and two V1
        // `schema-join` links.
        const v1Links =
            ['sales-orders-to-customer', 'sales-orders-to-supplier'].map(
                id => linkEntry(
                    id, ['sales.entities.orders', 'sales.entities.customer']));
        const {create, update, del, createLink, delLink} = stubClient({
          existing: [
            {id: 'sales', type: MODEL_TYPE},
            {id: 'sales.entities.orders', type: ENTITY_TYPE},
            {id: 'sales.entities.customer', type: ENTITY_TYPE},
            {id: 'sales.metrics.total_revenue', type: METRIC_TYPE},
            {id: 'sales.metrics.order_count', type: METRIC_TYPE},
          ],
          create: (id) => id === 'sales' ? err(409, 'already exists') : ok({}),
          links: (entry: string) => entry.endsWith('sales.entities.orders') ?
              ok(v1Links) :
              ok([]),
          createLink: () => ok({}),
        });

        const result = await deployKnowledgeCatalog(
            models(STAR_DOCS), CTX, {...OPTS, v2Aspects: true});

        expect(result.success).toBe(true);
        expect(result.updated).toBe(1);  // anchor 'sales'
        // 2 slash entities, 2 slash metrics and the relationship entry.
        expect(result.created).toBe(5);
        // The pair's semantic-link and the relationship's reference links.
        expect(result.linked).toBe(3);
        expect(result.deleted).toBe(4);   // 4 old dotted entries deleted
        expect(result.unlinked).toBe(2);  // both V1 schema-join links deleted
        expect(update).toHaveBeenCalledTimes(1);
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
// Pushes `docs` with KC_V2_ASPECTS on over a catalog that lists `existing`
// and answers each create with 409. `stubs` overrides any stub.
async function pushAgain(
    docs: {name: string; text: string}[], existing: Stubs['existing'],
    stubs: Stubs = {}) {
  const spies = stubClient(
      {create: EXISTS, ...stubs, existing: stubs.existing ?? existing});
  const result = await deployKnowledgeCatalog(models(docs), CTX, V2_OPTS);
  return {...spies, result};
}


describe('deployKnowledgeCatalog: V2 relationship entries and links', () => {
  const V2_ENTRIES = [
    {id: 'sales', type: MODEL_TYPE},
    {id: 'sales/entities/orders', type: ENTITY_TYPE},
    {id: 'sales/entities/customer', type: ENTITY_TYPE},
    {id: 'sales/metrics/total_revenue', type: METRIC_TYPE},
    {id: 'sales/metrics/order_count', type: METRIC_TYPE},
    {id: 'sales/relationships/orders_to_customer', type: RELATIONSHIP_TYPE},
  ];
  // A link of type `type` from entry `from` to entry `to`, as
  // lookupEntryLinks returns it with the project number.
  function directed(type: string, id: string, from: string, to: string) {
    const ref = (entry: string, type: string) =>
        ({name: entryName(entry, '123456789'), type});
    return {
      ...linkEntry(id, [], '123456789'),
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
  // STAR's link from orders to customer, and a link from customer to orders.
  const STAR_LINK = semanticLink(STAR_SEMANTIC_LINK, 'orders', 'customer');
  const BACK_ID = semanticLinkId('link', 'sales', 'customer', 'orders');
  const BACK_LINK = semanticLink(BACK_ID, 'customer', 'orders');
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
         const {del, delLink, updateLink, result} = await rePush({
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
         });

         expect(result.success).toBe(true);
         expect(result.deleted).toBe(1);
         expect(result.unlinked).toBe(3);
         expect(del.mock.calls.map(c => c[3]))
             .toEqual(['sales/relationships/customer_orders']);
         expect(delLink.mock.calls.map(c => c[3]))
             .toEqual([BACK_ID, ...dropped.map(l => l.name.split('/').pop())]);
         expect(updateLink).toHaveBeenCalledTimes(1);
       });

  // STAR with its relationship turned to run from customer to orders.
  const FLIPPED = STAR.replace(
      'from: orders\n        to: customer\n' +
          '        from_columns: [o_custkey]\n' +
          '        to_columns: [c_custkey]',
      'from: customer\n        to: orders\n' +
          '        from_columns: [c_custkey]\n' +
          '        to_columns: [o_custkey]');
  const SUPPLIER_ID = semanticLinkId('link', 'sales', 'orders', 'supplier');
  // Each case pushes `docs` again with `stubs`, tries to delete the links
  // `deleted` and fails with `details`.
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
     [{name: 'star.yaml', text: FLIPPED}], [STAR_SEMANTIC_LINK],
     `Model 'sales': entry link '${BACK_ID}': backend unavailable ` +
         `(push again to restore the link)`],
    ['a failed orphan delete gives no push-again hint when the read ' +
         'before the deletes found the kept link unchanged',
     {
       links: () => ok(
           [BACK_LINK, semanticLink(SUPPLIER_ID, 'orders', 'supplier')]),
       // getEntryLink returns the kept link unchanged.
       getLink:
           ok({...STAR_LINK, name: linkEntry(STAR_SEMANTIC_LINK, []).name}),
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
      expect(result).toMatchObject({success: false, details});
    });
  }
});
