// Tests that `--format=okf` routes init, pull and push to the OKF entry points
// (src/tool/commands.ts, src/libts/okf/*).
//
// The entry points are stubs, so there is no conversion to assert yet. What
// these tests pin is the wiring, which is the whole of CL 1: that the flag
// reaches the right function, that an unknown value is refused rather than
// quietly falling back to the default layout, and that omitting the flag
// leaves the existing paths untouched.
//
// The catalog client is spied throughout so no test reaches the network, and
// each runs in a temp cwd because the commands read and write catalog.yaml
// relative to it.

import {afterEach, beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {ApiContext} from '../../src/libts/gcp/context';
import {ApiResult} from '../../src/libts/gcp/api';
import {CatalogClient} from '../../src/libts/gcp/dataplex';
import * as catalogToOkfMod from '../../src/libts/okf/catalog_to_okf';
import * as initOkfMod from '../../src/libts/okf/init_okf_workspace';
import * as okfToCatalogMod from '../../src/libts/okf/okf_to_catalog';
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
  // A call no test stubs fails instead of reaching the network.
  spyOn(globalThis, 'fetch').mockImplementation((async () => {
    throw new Error('a test made a network call');
  }) as any);
  // Every command resolves its scope through the entry group.
  spyOn(CatalogClient.prototype, 'getEntryGroup')
      .mockImplementation(async () => ok({name: GROUP}));
});

afterEach(() => {
  process.chdir(cwd);
  if (dir) fs.rmSync(dir, {recursive: true, force: true});
  dir = '';
  mock.restore();
});

/** A workspace the non-OKF paths can load without touching the network. */
function writeManifest(): void {
  fs.writeFileSync(path.join(dir, 'catalog.yaml'), `scope: ${SCOPE}\n`);
}

describe('--format=okf dispatch', () => {
  test('pull routes to catalogToOkf and forwards --dry-run', async () => {
    writeManifest();
    const okf = spyOn(catalogToOkfMod, 'catalogToOkf')
                    .mockImplementation(async () => 0);

    expect(await pull({format: 'okf', dryRun: true})).toBe(0);

    expect(okf).toHaveBeenCalledTimes(1);
    const [, snapshot, options] = okf.mock.calls[0];
    expect(snapshot.manifest.source.name).toBe('test-project.us.kb');
    expect(options).toEqual({dryRun: true});
  });

  test('push routes to okfToCatalog and forwards --validate-only', async () => {
    writeManifest();
    const okf = spyOn(okfToCatalogMod, 'okfToCatalog')
                    .mockImplementation(async () => 0);

    expect(await push({format: 'okf', validateOnly: true})).toBe(0);

    expect(okf).toHaveBeenCalledTimes(1);
    expect(okf.mock.calls[0][2]).toEqual({validateOnly: true});
  });

  test('init routes to initOkfWorkspace and forwards --pull', async () => {
    const okf = spyOn(initOkfMod, 'initOkfWorkspace')
                    .mockImplementation(async () => 0);

    expect(await init({format: 'okf', entryGroup: 'test-project.us.kb', pull: true}))
        .toBe(0);

    expect(okf).toHaveBeenCalledTimes(1);
    const [, manifest, options] = okf.mock.calls[0];
    expect(manifest.source.name).toBe('test-project.us.kb');
    expect(options).toEqual({pull: true});
    // The OKF path owns scaffolding, so the default init must not have
    // written its manifest on the way past.
    expect(fs.existsSync(path.join(dir, 'catalog.yaml'))).toBe(false);
  });
});

describe('an unknown --format is refused', () => {
  test.each([['pull'], ['push'], ['init']])('%s rejects it', async (command) => {
    writeManifest();
    const run = {
      pull: () => pull({format: 'yaml'}),
      push: () => push({format: 'yaml'}),
      init: () => init({format: 'yaml', entryGroup: 'test-project.us.kb'}),
    }[command as 'pull' | 'push' | 'init'];

    await expect(run()).rejects.toThrow(/unknown --format 'yaml'/);
  });

  test('it is refused before any network call or context lookup', async () => {
    // The guard is the first statement in each handler, so a typo must not
    // cost a gcloud shell-out or an API round trip.
    const ctx = spyOn(ApiContext, 'default').mockReturnValue(CTX);
    const group = spyOn(CatalogClient.prototype, 'getEntryGroup')
                      .mockImplementation(async () => ok({name: GROUP}));

    await expect(pull({format: 'nope'})).rejects.toThrow();

    expect(ctx).not.toHaveBeenCalled();
    expect(group).not.toHaveBeenCalled();
  });
});

describe('without the flag the existing paths are untouched', () => {
  test('pull does not reach the OKF entry point', async () => {
    writeManifest();
    const okf = spyOn(catalogToOkfMod, 'catalogToOkf')
                    .mockImplementation(async () => 0);
    // The standard path runs its own sync; stub it out so this test asserts
    // only which branch was taken.
    spyOn(CatalogClient.prototype, 'listEntries')
        .mockImplementation(async function*() {});

    await pull({});

    expect(okf).not.toHaveBeenCalled();
  });

  test('init writes catalog.yaml as it always did', async () => {
    const okf = spyOn(initOkfMod, 'initOkfWorkspace')
                    .mockImplementation(async () => 0);

    expect(await init({entryGroup: 'test-project.us.kb'})).toBe(0);

    expect(okf).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(dir, 'catalog.yaml'), 'utf8'))
        .toContain(SCOPE);
  });
});

describe('the remaining stubs report not-implemented', () => {
  // catalogToOkf is implemented now; it is covered by catalog_to_okf.test.ts.
  // These two are still stubs, and this fails the moment either becomes real
  // -- the reminder to give it a test of its own.
  test('each returns a non-zero exit code', async () => {
    const snapshot = {manifest: {source: {name: 'test-project.us.kb'}}} as any;
    const manifest = {source: {name: 'test-project.us.kb'}} as any;

    expect(await okfToCatalogMod.okfToCatalog(CTX, snapshot)).toBe(1);
    expect(await initOkfMod.initOkfWorkspace(CTX, manifest)).toBe(1);
  });
});
