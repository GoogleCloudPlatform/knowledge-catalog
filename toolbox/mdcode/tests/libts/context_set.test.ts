// Tests for the context set's display name and description in catalog.yaml
// (src/libts/context_set.ts): which scopes take the keys, how they are
// compared with the entry group, and how pull and push move them.

import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {contextSetOf, MAX_DESCRIPTION_LENGTH, MAX_DISPLAY_NAME_LENGTH, metadataErrors, metadataOfEntryGroup, metadataScopeError, metadataUpdate, pullContextSetMetadata, pushContextSetMetadata, readContextSetMetadata, writeContextSetMetadata} from '../../src/libts/context_set';
import {ApiContext} from '../../src/libts/gcp/context';
import {CatalogClient} from '../../src/libts/gcp/dataplex';
import {CatalogManifest} from '../../src/libts/manifest';

const REF = {project: 'p', location: 'us', entryGroup: 'sales'};

let dir = '';
let manifest = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcmd-context-set-'));
  manifest = path.join(dir, 'catalog.yaml');
});

afterEach(() => {
  fs.rmSync(dir, {recursive: true, force: true});
});


// A catalog client that answers getEntryGroup with `group` and records each
// update. `updateStatus` and `opError` make the update fail.
function fakeCatalog(
    group: Record<string, unknown>|undefined,
    opts: {getStatus?: number; updateStatus?: number; opError?: string} = {}) {
  const updates: Array<{patch: unknown; mask: unknown}> = [];
  const catalog = {
    async getEntryGroup() {
      const status = opts.getStatus ?? 200;
      return status === 200 ? {status, result: group} :
                              {status, message: 'denied'};
    },
    async updateEntryGroup(
        _p: string, _l: string, _g: string, patch: unknown, mask: unknown) {
      updates.push({patch, mask});
      const status = opts.updateStatus ?? 200;
      return status === 200 ?
          {status, result: {name: 'projects/p/locations/us/operations/op'}} :
          {status, message: 'permission denied'};
    },
    async awaitOperation(_op: unknown, what: string) {
      return opts.opError && `${what}: ${opts.opError}`;
    },
  };
  return {catalog: catalog as unknown as CatalogClient, updates};
}


describe('which scopes take the keys', () => {
  // A source of scope type `type` and name `name`, as catalog.yaml names it.
  const source = (type: string, name: string) => ({type, name}) as any;

  test('entry group, knowledge base and semantic-model scopes', () => {
    expect(contextSetOf(source('entryGroup', 'p.us.sales')))
        .toEqual(expect.objectContaining(REF));
    expect(contextSetOf(source('kb', 'p.us.sales')))
        .toEqual(expect.objectContaining(REF));
    expect(contextSetOf(source('semantic-model', 'p.us.sales')))
        .toEqual(expect.objectContaining(REF));
    expect(contextSetOf(source('bq-dataset', 'p.d'))).toBeUndefined();
  });

  test('a source that names its entry group is used as it is', () => {
    // A semantic-model scope may have more than three parts.
    expect(contextSetOf({
      type: 'semantic-model',
      name: 'p.us.sales.v2',
      project: 'p',
      location: 'us',
      entryGroup: 'sales',
    } as any)).toEqual(REF);
  });

  test('a BigQuery dataset scope or a list of scopes refuses the keys', () => {
    expect(metadataScopeError('semantic-model.p.us.s', ['description']))
        .toBeUndefined();
    expect(metadataScopeError('bq-dataset.p.d', [])).toBeUndefined();
    expect(metadataScopeError('bq-dataset.p.d', ['displayName']))
        .toContain(
            '\'displayName\' apply only to scopes backed by an entry group');
    expect(metadataScopeError(
               ['bq-dataset.p.d1', 'bq-dataset.p.d2'],
               ['displayName', 'description']))
        .toContain('\'displayName\' and \'description\' apply only');
  });
});


describe('comparing with the entry group', () => {
  test('only a key the workspace holds, and that differs, is updated', () => {
    expect(metadataUpdate({}, {description: 'remote'})).toBeUndefined();
    expect(metadataUpdate({description: 'same'}, {description: 'same'}))
        .toBeUndefined();
    expect(metadataUpdate(
               {displayName: 'Sales', description: 'new'},
               {displayName: 'Sales', description: 'old'}))
        .toEqual({patch: {description: 'new'}, updateMask: ['description']});
  });

  test('an empty value clears a set one, and matches an unset one', () => {
    expect(metadataUpdate({description: ''}, {description: 'old'}))
        .toEqual({patch: {description: ''}, updateMask: ['description']});
    expect(metadataUpdate({description: ''}, {})).toBeUndefined();
  });

  test('an entry group\'s empty or missing values are left out', () => {
    expect(metadataOfEntryGroup(
               {name: 'n', displayName: '', description: 'd', type: 'x'}))
        .toEqual({description: 'd'});
    expect(metadataOfEntryGroup(undefined)).toEqual({});
  });

  test('values longer than Knowledge Catalog allows are errors', () => {
    expect(metadataErrors({
      displayName: 'n'.repeat(MAX_DISPLAY_NAME_LENGTH),
      description: 'd'.repeat(MAX_DESCRIPTION_LENGTH),
    })).toEqual([]);
    expect(metadataErrors({
      displayName: 'n'.repeat(MAX_DISPLAY_NAME_LENGTH + 1),
      description: 'd'.repeat(MAX_DESCRIPTION_LENGTH + 1),
    })).toEqual([
      expect.stringContaining('display name is 257 characters long'),
      expect.stringContaining('description is 1025 characters long'),
    ]);
  });
});


describe('writing catalog.yaml', () => {
  test('sets the keys and keeps every other key and comment', () => {
    fs.writeFileSync(
        manifest,
        '# The sales workspace.\nscope: semantic-model.p.us.sales # pinned\n' +
            'snapshot:\n  aspects: [p.global.a]   # listed\n\n' +
            'publishing:\n    aspects:\n        - p.global.a\n');
    expect(writeContextSetMetadata(
               manifest, {displayName: 'Sales', description: 'Orders.'}))
        .toEqual(['displayName', 'description']);
    const text = fs.readFileSync(manifest, 'utf8');
    // Every line the pull does not change comes back byte for byte.
    expect(text).toStartWith(
        '# The sales workspace.\nscope: semantic-model.p.us.sales # pinned\n' +
        'snapshot:\n  aspects: [p.global.a]   # listed\n\n' +
        'publishing:\n    aspects:\n        - p.global.a\n');
    expect(readContextSetMetadata(manifest))
        .toEqual({displayName: 'Sales', description: 'Orders.'});
  });

  test('removes a key the entry group does not set', () => {
    fs.writeFileSync(
        manifest, 'scope: entryGroup.p.us.sales\ndescription: old\n');
    expect(writeContextSetMetadata(manifest, {})).toEqual(['description']);
    expect(fs.readFileSync(manifest, 'utf8'))
        .toBe('scope: entryGroup.p.us.sales\n');
  });

  test('leaves the file untouched when nothing changes', () => {
    const text = 'scope: entryGroup.p.us.sales\ndescription:   "same"\n';
    fs.writeFileSync(manifest, text);
    expect(writeContextSetMetadata(manifest, {description: 'same'}))
        .toEqual([]);
    expect(fs.readFileSync(manifest, 'utf8')).toBe(text);
  });

  test('keeps CRLF line endings', () => {
    fs.writeFileSync(manifest, 'scope: entryGroup.p.us.sales\r\nlayout: okf\r\n');
    writeContextSetMetadata(manifest, {description: 'Orders.'});
    const text = fs.readFileSync(manifest, 'utf8');
    expect(text).toStartWith('scope: entryGroup.p.us.sales\r\nlayout: okf\r\n');
    expect(text.replace(/\r\n/g, '')).not.toContain('\n');
  });

  test('keeps a byte order mark outside the keys it adds', () => {
    fs.writeFileSync(manifest, '\uFEFFscope: entryGroup.p.us.sales\n');
    writeContextSetMetadata(manifest, {displayName: 'Sales'});
    expect(fs.readFileSync(manifest, 'utf8'))
        .toBe('\uFEFFscope: entryGroup.p.us.sales\ndisplayName: Sales\n');
    expect(readContextSetMetadata(manifest)).toEqual({displayName: 'Sales'});
  });

  test('an empty value is kept while the entry group sets none', () => {
    const text = 'scope: entryGroup.p.us.sales\ndescription: ""\n';
    fs.writeFileSync(manifest, text);
    expect(writeContextSetMetadata(manifest, {})).toEqual([]);
    expect(fs.readFileSync(manifest, 'utf8')).toBe(text);
  });

  test('keeps a multi-line description', () => {
    fs.writeFileSync(manifest, 'scope: entryGroup.p.us.sales\n');
    const description = 'Semantic model `sales`:\norders and refunds.';
    writeContextSetMetadata(manifest, {description});
    expect(readContextSetMetadata(manifest)).toEqual({description});
  });
});


describe('pullContextSetMetadata', () => {
  test('writes the entry group\'s values to catalog.yaml', async () => {
    fs.writeFileSync(manifest, 'scope: semantic-model.p.us.sales\n');
    const {catalog} =
        fakeCatalog({name: 'n', displayName: 'Sales', description: 'Orders.'});
    expect(await pullContextSetMetadata(catalog, REF, manifest))
        .toEqual({changed: ['displayName', 'description']});
    expect(readContextSetMetadata(manifest))
        .toEqual({displayName: 'Sales', description: 'Orders.'});
  });

  test('a dry run reports what would change and writes nothing', async () => {
    const text = 'scope: semantic-model.p.us.sales\ndescription: local\n';
    fs.writeFileSync(manifest, text);
    const {catalog} = fakeCatalog({name: 'n', description: 'remote'});
    expect(await pullContextSetMetadata(catalog, REF, manifest, {dryRun: true}))
        .toEqual({changed: ['description']});
    expect(fs.readFileSync(manifest, 'utf8')).toBe(text);
  });

  test('a failed read is an error and writes nothing', async () => {
    const text = 'scope: semantic-model.p.us.sales\n';
    fs.writeFileSync(manifest, text);
    const {catalog} = fakeCatalog(undefined, {getStatus: 403});
    expect(await pullContextSetMetadata(catalog, REF, manifest)).toEqual({
      changed: [],
      error: 'reading context set \'p.us.sales\': denied',
    });
    expect(fs.readFileSync(manifest, 'utf8')).toBe(text);
  });
});


describe('pushContextSetMetadata', () => {
  test('updates only what differs, with an update mask', async () => {
    const {catalog, updates} =
        fakeCatalog({name: 'n', displayName: 'Sales', description: 'old'});
    expect(await pushContextSetMetadata(
               catalog, REF, {displayName: 'Sales', description: 'new'}))
        .toEqual({changed: ['description']});
    expect(updates).toEqual(
        [{patch: {description: 'new'}, mask: ['description']}]);
  });

  test('no keys, or no difference, calls nothing to update', async () => {
    const {catalog, updates} = fakeCatalog({name: 'n', description: 'same'});
    expect(await pushContextSetMetadata(catalog, REF, {}))
        .toEqual({changed: []});
    expect(await pushContextSetMetadata(catalog, REF, {description: 'same'}))
        .toEqual({changed: []});
    expect(updates).toEqual([]);
  });

  test('validate-only reports the change and writes nothing', async () => {
    const {catalog, updates} = fakeCatalog({name: 'n'});
    expect(await pushContextSetMetadata(
               catalog, REF, {displayName: 'Sales'}, {validateOnly: true}))
        .toEqual({changed: ['displayName']});
    expect(updates).toEqual([]);
  });

  test('a refused update and a failed operation are errors', async () => {
    const refused =
        fakeCatalog({name: 'n'}, {updateStatus: 403}).catalog;
    expect(await pushContextSetMetadata(refused, REF, {description: 'd'}))
        .toEqual({
          changed: [],
          error: 'updating context set \'p.us.sales\': permission denied',
        });
    const failed = fakeCatalog({name: 'n'}, {opError: 'boom'}).catalog;
    expect(await pushContextSetMetadata(failed, REF, {description: 'd'}))
        .toEqual({
          changed: [],
          error: 'updating context set \'p.us.sales\': boom',
        });
  });
});


describe('CatalogManifest', () => {
  const ctx = new ApiContext('p', 'us', 'token');

  test('loads the keys and keeps them when it saves', async () => {
    fs.writeFileSync(
        manifest,
        'scope: semantic-model.p.us.sales\ndisplayName: Sales\n' +
            'description: Orders.\n');
    const loaded = await CatalogManifest.load(manifest, ctx);
    expect(loaded.contextSet)
        .toEqual({displayName: 'Sales', description: 'Orders.'});
    const saved = path.join(dir, 'saved.yaml');
    loaded.save(saved);
    expect(readContextSetMetadata(saved))
        .toEqual({displayName: 'Sales', description: 'Orders.'});
  });

  test('a workspace without the keys has none', async () => {
    fs.writeFileSync(manifest, 'scope: semantic-model.p.us.sales\n');
    expect((await CatalogManifest.load(manifest, ctx)).contextSet).toEqual({});
  });

  test('a key with no value loads as not managed', async () => {
    fs.writeFileSync(
        manifest,
        'scope: semantic-model.p.us.sales\ndisplayName: ~\ndescription:\n');
    expect((await CatalogManifest.load(manifest, ctx)).contextSet).toEqual({});
  });

  test('a value that is not a string does not load', async () => {
    fs.writeFileSync(
        manifest, 'scope: semantic-model.p.us.sales\ndisplayName: 42\n');
    await expect(CatalogManifest.load(manifest, ctx))
        .rejects.toThrow('Manifest error');
  });

  test('refuses the keys in a BigQuery dataset scope, before any call',
       async () => {
         fs.writeFileSync(
             manifest, 'scope: bq-dataset.p.d\ndescription: Orders.\n');
         await expect(CatalogManifest.load(manifest, ctx))
             .rejects.toThrow('apply only to scopes backed by an entry group');
       });
});
