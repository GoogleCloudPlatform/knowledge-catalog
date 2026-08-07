// Tests for the semantic-model Knowledge Catalog deploy leg
// (src/libts/semantic/deploy_knowledge_catalog.ts).
//
// `deployKnowledgeCatalog` is exercised end to end over an Ossie fixture
// (loader -> IR -> emitter -> writes), with the catalog client stubbed so no
// network call is made. The focus is the publish SEQUENCE the emitter
// goldens cannot show: entry-group-only provisioning (no type creation),
// anchor-first entry writes, idempotent upsert on re-push, and the dry-run
// plan.

import {afterEach, describe, expect, mock, spyOn, test} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {ApiResult} from '../../../src/libts/gcp/api';
import {ApiContext} from '../../../src/libts/gcp/context';
import {CatalogClient} from '../../../src/libts/gcp/dataplex';
import {deployKnowledgeCatalog} from '../../../src/libts/semantic/deploy_knowledge_catalog';

const CTX = new ApiContext('test-project', 'us', 'test-token');
const FIXTURES = path.join(__dirname, 'fixtures');

// A loader-valid model: one entity (orders) + one metric (total_revenue), so a
// push writes exactly three entries (model anchor + entity + metric).
const OSSIE =
    fs.readFileSync(path.join(FIXTURES, 'sales_bq_graph_target.yaml'), 'utf8');
const DOCS = [{name: 'sales.yaml', text: OSSIE}];

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

// Stubs createEntryGroup + createEntry (+ optionally updateEntry) and returns
// the spies so a test can assert call counts and ordering.
function stubClient(opts: {
  group?: ApiResult<any>,
  create?: (entryId: string) => ApiResult<any>,
  update?: ApiResult<any>,
} = {}) {
  const group = spyOn(CatalogClient.prototype, 'createEntryGroup')
                    .mockImplementation(async () => opts.group ?? ok({}));
  const create = spyOn(CatalogClient.prototype, 'createEntry')
                     .mockImplementation(
                         async (_p, _l, _eg, entryId) =>
                             (opts.create ?? (() => ok({})))(entryId));
  const update = spyOn(CatalogClient.prototype, 'updateEntry')
                     .mockImplementation(async () => opts.update ?? ok({}));
  return {group, create, update};
}


describe('deployKnowledgeCatalog: happy path', () => {
  test(
      'provisions only the entry group, then writes entries anchor-first',
      async () => {
        const {group, create, update} = stubClient();

        const result = await deployKnowledgeCatalog(DOCS, CTX, OPTS);

        expect(result.success).toBe(true);
        expect(result.created).toBe(3);
        expect(result.updated).toBe(0);

        // Entry group ensured exactly once; no aspect/entry TYPE creation
        // exists on the client at all (the semantic types are built-in) —
        // nothing to provision.
        expect(group).toHaveBeenCalledTimes(1);
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

    const result = await deployKnowledgeCatalog(DOCS, CTX, OPTS);

    expect(result.success).toBe(true);
    expect(result.created).toBe(0);
    expect(result.updated).toBe(3);
    expect(create).toHaveBeenCalledTimes(3);
    expect(update).toHaveBeenCalledTimes(3);
  });
});


describe('deployKnowledgeCatalog: validateOnly', () => {
  test('writes nothing and returns a plan', async () => {
    const {group, create} = stubClient();

    const result =
        await deployKnowledgeCatalog(DOCS, CTX, {...OPTS, validateOnly: true});

    expect(result.success).toBe(true);
    expect(result.created).toBe(0);
    expect(group).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(result.plan.join('\n')).toContain('Knowledge Catalog plan');
    expect(result.plan.join('\n')).toContain('sales');
  });
});


describe('deployKnowledgeCatalog: idempotent provisioning', () => {
  test('an already-existing entry group is not an error', async () => {
    const {create} =
        stubClient({group: err(409, 'Entry group already exists')});

    const result = await deployKnowledgeCatalog(DOCS, CTX, OPTS);

    expect(result.success).toBe(true);
    expect(create).toHaveBeenCalledTimes(3);
  });
});


describe('deployKnowledgeCatalog: failures', () => {
  test(
      'a fatal entry-group error stops before any entry is written',
      async () => {
        const {create} = stubClient({group: err(403, 'permission denied')});

        const result = await deployKnowledgeCatalog(DOCS, CTX, OPTS);

        expect(result.success).toBe(false);
        expect(result.details).toContain('entry group');
        expect(create).not.toHaveBeenCalled();
      });

  test('a failed anchor write stops before its children', async () => {
    const {create} = stubClient({
      create: (id) => id === 'sales' ? err(500, 'boom') : ok({}),
    });

    const result = await deployKnowledgeCatalog(DOCS, CTX, OPTS);

    expect(result.success).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);  // anchor only; children skipped
  });

  test('a malformed document fails with the document named', async () => {
    stubClient();
    const bad =
        [{name: 'bad.yaml', text: 'semantic_model: [ this is: not valid'}];

    const result = await deployKnowledgeCatalog(bad, CTX, OPTS);

    expect(result.success).toBe(false);
    expect(result.details).toContain('bad.yaml');
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
