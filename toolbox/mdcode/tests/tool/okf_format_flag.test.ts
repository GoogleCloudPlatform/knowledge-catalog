// Tests how a workspace chooses the OKF path (src/tool/commands.ts,
// src/libts/manifest.ts, src/libts/okf/init_okf_workspace.ts):
// `kcmd init --format okf` records `layout: okf` in catalog.yaml, and
// `kcmd pull` and `kcmd push` read it from there, so they take no flag. An
// unknown format or layout is refused rather than quietly falling back to the
// default layout, and a workspace without a layout keeps the existing paths.
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
import {CatalogManifest, readWorkspaceLayout} from '../../src/libts/manifest';
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

/** A workspace with the given extra catalog.yaml lines. */
function writeManifest(extra = ''): void {
  fs.writeFileSync(path.join(dir, 'catalog.yaml'), `scope: ${SCOPE}\n${extra}`);
}

describe('an OKF workspace (layout: okf)', () => {
  test('pull routes to catalogToOkf and forwards --dry-run', async () => {
    writeManifest('layout: okf\n');
    const okf = spyOn(catalogToOkfMod, 'catalogToOkf')
                    .mockImplementation(async () => 0);

    expect(await pull({dryRun: true})).toBe(0);

    expect(okf).toHaveBeenCalledTimes(1);
    const [, snapshot, options] = okf.mock.calls[0];
    expect(snapshot.manifest.source.name).toBe('test-project.us.kb');
    expect(snapshot.manifest.layout).toBe('okf');
    expect(options).toEqual({dryRun: true});
  });

  test('push routes to okfToCatalog and forwards --validate-only', async () => {
    writeManifest('layout: okf\n');
    const okf = spyOn(okfToCatalogMod, 'okfToCatalog')
                    .mockImplementation(async () => 0);

    expect(await push({validateOnly: true})).toBe(0);

    expect(okf).toHaveBeenCalledTimes(1);
    expect(okf.mock.calls[0][2]).toEqual({validateOnly: true});
  });

  test('push --dry-run is the same as --validate-only', async () => {
    writeManifest('layout: okf\n');
    const okf = spyOn(okfToCatalogMod, 'okfToCatalog')
                    .mockImplementation(async () => 0);

    expect(await push({dryRun: true})).toBe(0);

    expect(okf.mock.calls[0][2]).toEqual({validateOnly: true});
  });

  test('init --format okf routes to initOkfWorkspace and forwards --pull', async () => {
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

describe('an unknown format or layout is refused', () => {
  test('init rejects an unknown --format', async () => {
    await expect(init({format: 'yaml', entryGroup: 'test-project.us.kb'}))
        .rejects.toThrow(/unknown --format 'yaml'/);
  });

  test.each([['pull'], ['push']])(
      '%s rejects an unknown layout before any network call or context lookup',
      async (command) => {
        writeManifest('layout: split\n');
        const ctx = spyOn(ApiContext, 'default').mockReturnValue(CTX);
        const group = spyOn(CatalogClient.prototype, 'getEntryGroup')
                          .mockImplementation(async () => ok({name: GROUP}));

        const run = command === 'pull' ? () => pull() : () => push({});
        await expect(run()).rejects.toThrow(/layout 'split' is not supported/);

        expect(ctx).not.toHaveBeenCalled();
        expect(group).not.toHaveBeenCalled();
      });

  test('a layout on a scope that does not take one is refused', async () => {
    writeManifest('');
    fs.writeFileSync(
        path.join(dir, 'catalog.yaml'),
        'scope: semantic-model.test-project.us.kb\nlayout: okf\n');
    expect(() => readWorkspaceLayout(path.join(dir, 'catalog.yaml')))
        .toThrow(/applies only to 'entryGroup' and 'kb' scopes/);
  });
});

describe('a workspace without a layout keeps the existing paths', () => {
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

  test('push does not reach the OKF entry point', async () => {
    writeManifest();
    const okf = spyOn(okfToCatalogMod, 'okfToCatalog')
                    .mockImplementation(async () => 0);
    spyOn(CatalogClient.prototype, 'listEntries')
        .mockImplementation(async function*() {});

    await push({validateOnly: true});

    expect(okf).not.toHaveBeenCalled();
  });

  test('init writes catalog.yaml as it always did, with no layout', async () => {
    const okf = spyOn(initOkfMod, 'initOkfWorkspace')
                    .mockImplementation(async () => 0);

    expect(await init({entryGroup: 'test-project.us.kb'})).toBe(0);

    expect(okf).not.toHaveBeenCalled();
    const text = fs.readFileSync(path.join(dir, 'catalog.yaml'), 'utf8');
    expect(text).toContain(SCOPE);
    expect(text).not.toContain('layout:');
  });
});

describe('initOkfWorkspace scaffolds catalog.yaml and bundle/index.md', () => {
  test('writes catalog.yaml with layout: okf and bundle/index.md', async () => {
    const manifest = {
      source: {type: 'entryGroup', name: 'test-project.us.kb'},
    } as any;

    expect(await initOkfMod.initOkfWorkspace(CTX, manifest, {pull: false})).toBe(0);
    const text = fs.readFileSync(path.join(dir, 'catalog.yaml'), 'utf8');
    expect(text).toContain('entryGroup.test-project.us.kb');
    expect(readWorkspaceLayout(path.join(dir, 'catalog.yaml'))).toBe('okf');
    expect(
      fs.readFileSync(path.join(dir, 'bundle', 'index.md'), 'utf8'),
    ).toContain('okf_version: "0.2"');
  });

  test('re-running init for the same scope keeps every key and comment', async () => {
    writeManifest('# hand-written\nsnapshot:\n  aspects:\n    - p.l.x\n');
    const manifest = {
      source: {type: 'entryGroup', name: 'test-project.us.kb'},
    } as any;

    expect(await initOkfMod.initOkfWorkspace(CTX, manifest, {pull: false})).toBe(0);
    const text = fs.readFileSync(path.join(dir, 'catalog.yaml'), 'utf8');
    expect(text).toContain('# hand-written');
    expect(text).toContain('p.l.x');
    expect(text).toContain('layout: okf');
  });

  test('a loaded manifest exposes the layout and saves it back', async () => {
    writeManifest('layout: okf\n');
    const manifest =
        await CatalogManifest.load(path.join(dir, 'catalog.yaml'), CTX);
    expect(manifest.layout).toBe('okf');
    manifest.save(path.join(dir, 'saved.yaml'));
    expect(fs.readFileSync(path.join(dir, 'saved.yaml'), 'utf8'))
        .toContain('layout: okf');
  });

  test('returns 1 on a malformed scope name', async () => {
    const manifest = {source: {name: 'bad-scope'}} as any;

    expect(await initOkfMod.initOkfWorkspace(CTX, manifest)).toBe(1);
  });
});
