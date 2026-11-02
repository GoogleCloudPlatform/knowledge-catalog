// Tests that `--format=okf` routes pull and push through OkfLayout + CatalogSync.

import {afterEach, beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {ApiResult} from '../../src/libts/gcp/api';
import {ApiContext} from '../../src/libts/gcp/context';
import {CatalogClient} from '../../src/libts/gcp/dataplex';
import {OkfLayout} from '../../src/libts/layouts/okf';
import {CatalogSnapshot} from '../../src/libts/snapshot';
import {CatalogSync} from '../../src/libts/sync';
import {init, pull, push} from '../../src/tool/commands';

const CTX = new ApiContext('test-project', 'us', 'test-token');
const SCOPE = 'entryGroup.test-project.us.kb';
const GROUP = 'projects/test-project/locations/us/entryGroups/kb';

function ok<T>(result?: T): ApiResult<T> {
  return {status: 200, result};
}

let dir = '';
let cwd = '';

beforeEach(() => {
  cwd = process.cwd();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcmd-okf-flag-'));
  process.chdir(dir);

  spyOn(ApiContext, 'default').mockReturnValue(CTX);
  spyOn(console, 'log').mockImplementation(() => {});
  spyOn(console, 'error').mockImplementation(() => {});
  spyOn(console, 'warn').mockImplementation(() => {});
  spyOn(globalThis, 'fetch').mockImplementation((async () => {
    throw new Error('a test made a network call');
  }) as any);
  spyOn(CatalogClient.prototype, 'getEntryGroup').mockImplementation(
    async () => ok({name: GROUP}),
  );
});

afterEach(() => {
  process.chdir(cwd);
  if (dir) fs.rmSync(dir, {recursive: true, force: true});
  dir = '';
  mock.restore();
});

function writeManifest(scope = SCOPE): void {
  fs.writeFileSync(path.join(dir, 'catalog.yaml'), `scope: ${scope}\n`);
}

describe('--format=okf dispatch', () => {
  test('pull constructs an OkfLayout snapshot and forwards --dry-run and --force-remove', async () => {
    writeManifest();
    let seenLayout: unknown;
    const origFromPath = CatalogSnapshot.fromPath.bind(CatalogSnapshot);
    spyOn(CatalogSnapshot, 'fromPath').mockImplementation(
      async (...args: Parameters<typeof CatalogSnapshot.fromPath>) => {
        const snap = await origFromPath(...args);
        seenLayout = snap.layout;
        return snap;
      },
    );
    const pullSpy = spyOn(CatalogSync.prototype, 'pull').mockImplementation(
      async () => ({success: true}),
    );

    expect(await pull({format: 'okf', dryRun: true, forceRemove: true})).toBe(0);

    expect(seenLayout).toBeInstanceOf(OkfLayout);
    expect(pullSpy).toHaveBeenCalledWith({dryRun: true, forceRemove: true});
  });

  test('push constructs an OkfLayout snapshot and forwards --validate-only', async () => {
    writeManifest();
    let seenLayout: unknown;
    const origFromPath = CatalogSnapshot.fromPath.bind(CatalogSnapshot);
    spyOn(CatalogSnapshot, 'fromPath').mockImplementation(
      async (...args: Parameters<typeof CatalogSnapshot.fromPath>) => {
        const snap = await origFromPath(...args);
        seenLayout = snap.layout;
        return snap;
      },
    );
    const pushSpy = spyOn(CatalogSync.prototype, 'push').mockImplementation(
      async () => ({success: true}),
    );

    expect(await push({format: 'okf', validateOnly: true})).toBe(0);

    expect(seenLayout).toBeInstanceOf(OkfLayout);
    expect(pushSpy).toHaveBeenCalledWith({force: undefined, validateOnly: true});
  });

  test('accepts kb scopes as well as entryGroup scopes', async () => {
    writeManifest('kb.test-project.us.kb');
    spyOn(CatalogClient.prototype, 'listEntries').mockImplementation(
      async function* () {},
    );

    expect(await pull({format: 'okf', dryRun: true})).toBe(0);
  });

  test('rejects non-EntryGroup scopes with a clear message', async () => {
    writeManifest('semantic-model.test-project.us.kb');

    await expect(pull({format: 'okf'})).rejects.toThrow(
      /applies only to 'entryGroup' and 'kb' scopes/,
    );
  });
});

describe('an unknown --format is refused', () => {
  test.each([['pull'], ['push']])('%s rejects it', async (command) => {
    writeManifest();
    const run = {
      pull: () => pull({format: 'yaml'}),
      push: () => push({format: 'yaml'}),
    }[command as 'pull' | 'push'];

    await expect(run()).rejects.toThrow(/unknown --format 'yaml'/);
  });

  test('it is refused before any network call or context lookup', async () => {
    const ctx = spyOn(ApiContext, 'default').mockReturnValue(CTX);
    const group = spyOn(CatalogClient.prototype, 'getEntryGroup')
      .mockImplementation(async () => ok({name: GROUP}));

    await expect(pull({format: 'nope'})).rejects.toThrow();

    expect(ctx).not.toHaveBeenCalled();
    expect(group).not.toHaveBeenCalled();
  });
});

describe('without the flag the existing paths are untouched', () => {
  test('pull uses the scope default layout rather than OkfLayout', async () => {
    writeManifest();
    let seenLayout: unknown;
    const origFromPath = CatalogSnapshot.fromPath.bind(CatalogSnapshot);
    spyOn(CatalogSnapshot, 'fromPath').mockImplementation(
      async (...args: Parameters<typeof CatalogSnapshot.fromPath>) => {
        const snap = await origFromPath(...args);
        seenLayout = snap.layout;
        return snap;
      },
    );
    spyOn(CatalogClient.prototype, 'listEntries').mockImplementation(
      async function* () {},
    );

    await pull({});

    expect(seenLayout).not.toBeInstanceOf(OkfLayout);
  });

  test('init writes catalog.yaml as it always did', async () => {
    expect(await init({entryGroup: 'test-project.us.kb'})).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'catalog.yaml'), 'utf8')).toContain(
      SCOPE,
    );
  });
});
