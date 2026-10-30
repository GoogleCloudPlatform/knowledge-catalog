// Tests `kcmd pull --format=okf` writing an OKF bundle
// (src/libts/okf/catalog_to_okf.ts).
//
// The catalog client is spied so nothing reaches the network, and each test
// runs in a temp cwd because the path reads catalog.yaml and writes `bundle/`
// relative to it.

import {afterEach, beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {ApiResult} from '../../src/libts/gcp/api';
import {ApiContext} from '../../src/libts/gcp/context';
import {CatalogClient, Entry} from '../../src/libts/gcp/dataplex';
import {pull} from '../../src/tool/commands';

const CTX = new ApiContext('p', 'us', 'token');
const GROUP = 'projects/p/locations/us/entryGroups/kb';
const OVERVIEW = 'dataplex-types.global.overview';

function ok<T>(result?: T): ApiResult<T> {
  return {status: 200, result};
}

/** An entry as lookupEntry returns it. */
function entry(id: string, over?: Partial<Entry>): Entry {
  return {
    name: `${GROUP}/entries/${id}`,
    entryType: 'projects/dataplex-types/locations/global/entryTypes/generic',
    entrySource: {displayName: id.split('/').pop(), resource: `bq://${id}`},
    ...over,
  } as Entry;
}

function withOverview(id: string, content: string): Entry {
  return entry(id, {
    aspects: {[OVERVIEW]: {data: {content, contentType: 'MARKDOWN'}}},
  } as Partial<Entry>);
}

let dir = '';
let cwd = '';

/** Makes the scope resolve and `listEntries` yield the given entries. */
function stubCatalog(entries: Entry[]): void {
  spyOn(CatalogClient.prototype, 'getEntryGroup')
      .mockImplementation(async () => ok({name: GROUP}));
  spyOn(CatalogClient.prototype, 'listEntries')
      .mockImplementation(async function*() {
        for (const e of entries) yield e;
      } as any);
  spyOn(CatalogClient.prototype, 'lookupEntry')
      .mockImplementation(async (_p: string, _l: string, name: string) =>
          ok(entries.find(e => e.name === name)));
}

beforeEach(() => {
  cwd = process.cwd();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcmd-c2okf-'));
  process.chdir(dir);
  fs.writeFileSync('catalog.yaml', 'scope: entryGroup.p.us.kb\n');

  spyOn(ApiContext, 'default').mockReturnValue(CTX);
  spyOn(console, 'log').mockImplementation(() => {});
  spyOn(console, 'error').mockImplementation(() => {});
  spyOn(console, 'warn').mockImplementation(() => {});
  spyOn(globalThis, 'fetch').mockImplementation((async () => {
    throw new Error('a test made a network call');
  }) as any);
});

afterEach(() => {
  process.chdir(cwd);
  if (dir) fs.rmSync(dir, {recursive: true, force: true});
  dir = '';
  mock.restore();
});

function read(rel: string): string {
  return fs.readFileSync(path.join(dir, 'bundle', rel), 'utf8');
}

describe('catalogToOkf', () => {
  test('writes one concept per entry, under bundle/', async () => {
    stubCatalog([withOverview('tables/trips', '# Trips\n\nProse.\n')]);

    expect(await pull({format: 'okf'})).toBe(0);

    // The bundle is a sibling of catalog.yaml, never its parent: the manifest
    // must stay out of the bundle so the bundle is portable OKF.
    expect(fs.existsSync(path.join(dir, 'catalog.yaml'))).toBe(true);
    expect(read('tables/trips.md')).toBe(
        '---\n' +
        'type: generic\n' +
        'title: trips\n' +
        'resource: bq://tables/trips\n' +
        'x-kcmd:\n' +
        '  v: 1\n' +
        '  entryType: projects/dataplex-types/locations/global/entryTypes/generic\n' +
        '---\n' +
        '# Trips\n\nProse.\n');
  });

  test('the overview aspect becomes the markdown body', async () => {
    stubCatalog([withOverview('a', 'body text')]);
    await pull({format: 'okf'});
    expect(read('a.md')).toEndWith('---\nbody text\n');
  });

  test('an entry with no overview still yields a valid concept', async () => {
    // SPEC §4.1: `type` is the only required key, so a bodyless concept is
    // conformant and must not be skipped.
    stubCatalog([entry('a')]);
    await pull({format: 'okf'});
    expect(read('a.md')).toContain('type: generic');
  });

  test('type comes from the aspect naming the entry type', async () => {
    stubCatalog([entry('a', {
      aspects: {'dataplex-types.global.generic': {data: {type: 'context-overlay'}}},
    } as Partial<Entry>)]);
    await pull({format: 'okf'});
    expect(read('a.md')).toContain('type: context-overlay');
  });

  test('description and resource are omitted when absent', async () => {
    stubCatalog([entry('a', {entrySource: {displayName: 'a'}} as Partial<Entry>)]);
    await pull({format: 'okf'});
    const text = read('a.md');
    expect(text).not.toContain('description:');
    expect(text).not.toContain('resource:');
  });

  test('nested entry ids become nested directories', async () => {
    stubCatalog([withOverview('assets/bigquery/p.d.t', 'x')]);
    await pull({format: 'okf'});
    expect(fs.existsSync(path.join(dir, 'bundle/assets/bigquery/p.d.t.md')))
        .toBe(true);
  });

  test('--dry-run writes nothing', async () => {
    stubCatalog([withOverview('a', 'x')]);

    expect(await pull({format: 'okf', dryRun: true})).toBe(0);

    expect(fs.existsSync(path.join(dir, 'bundle'))).toBe(false);
  });

  test('a failed entry read aborts instead of writing a bodyless concept', async () => {
    // lookupEntry answers 403 for both "no such entry" and "no permission".
    // Falling back to the aspect-less list stub would write a concept that
    // looks real and has lost its body.
    stubCatalog([withOverview('a', 'x')]);
    spyOn(CatalogClient.prototype, 'lookupEntry')
        .mockImplementation(async () => ({status: 403, message: 'denied'}) as any);

    await expect(pull({format: 'okf'})).rejects.toThrow(/failed to read entry/);
    expect(fs.existsSync(path.join(dir, 'bundle'))).toBe(false);
  });

  test('aspects other than overview ride in the residue', async () => {
    stubCatalog([entry('a', {
      aspects: {
        [OVERVIEW]: {data: {content: 'body'}},
        'dataplex-types.global.schema': {data: {fields: [{name: 'c'}]}},
      },
    } as Partial<Entry>)]);

    await pull({format: 'okf'});

    const text = read('a.md');
    expect(text).toContain('dataplex-types.global.schema');
    expect(text).toContain('fields');
    // The overview is the body, so it must not also sit in the residue.
    expect(text.split('---')[1]).not.toContain('content: body');
  });
});
