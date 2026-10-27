// Tests that a context-set scope drives both of its halves
// (src/tool/commands.ts): pull reconstructs the semantic model and then
// writes the OKF bundle, push publishes the model and then the bundle, and
// the bundle leg is gated on the model leg succeeding.
//
// The model leg is driven through pullKnowledgeCatalog rather than
// re-deriving a whole model here; what these tests pin is the ordering and
// the gate. The catalog client is spied throughout so nothing reaches the
// network, and each test runs in a temp cwd because the commands read
// catalog.yaml relative to it.

import {afterEach, beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {ApiResult} from '../../src/libts/gcp/api';
import {ApiContext} from '../../src/libts/gcp/context';
import {CatalogClient} from '../../src/libts/gcp/dataplex';
import * as catalogToOkfMod from '../../src/libts/okf/catalog_to_okf';
import * as okfToCatalogMod from '../../src/libts/okf/okf_to_catalog';
import * as pullKcMod from '../../src/libts/semantic/pull_kc';
import {pull, push} from '../../src/tool/commands';

const CTX = new ApiContext('test-project', 'us', 'test-token');
const SCOPE = 'context-set.test-project.us.eg';
const GROUP = 'projects/test-project/locations/us/entryGroups/eg';

function ok<T>(result?: T): ApiResult<T> {
  return {status: 200, result};
}

let dir = '';
let cwd = '';

beforeEach(() => {
  cwd = process.cwd();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcmd-context-set-'));
  process.chdir(dir);
  fs.writeFileSync(path.join(dir, 'catalog.yaml'), `scope: ${SCOPE}\n`);

  spyOn(ApiContext, 'default').mockReturnValue(CTX);
  spyOn(console, 'log').mockImplementation(() => {});
  spyOn(console, 'error').mockImplementation(() => {});
  spyOn(console, 'warn').mockImplementation(() => {});
  spyOn(globalThis, 'fetch').mockImplementation((async () => {
    throw new Error('a test made a network call');
  }) as any);
  spyOn(CatalogClient.prototype, 'getEntryGroup')
      .mockImplementation(async () => ok({name: GROUP}));
});

afterEach(() => {
  process.chdir(cwd);
  if (dir) fs.rmSync(dir, {recursive: true, force: true});
  dir = '';
  mock.restore();
});

/** A model leg that finds nothing to pull, which succeeds. */
function emptyCatalog() {
  return spyOn(pullKcMod, 'pullKnowledgeCatalog')
      .mockImplementation(async () => ({models: [], warnings: []}) as any);
}

/**
 * A model leg that fails: the catalog holds a model this workspace does not,
 * which pull refuses without --force-remove rather than leave two behind.
 */
function conflictingCatalog() {
  const groupDir = path.join(dir, 'catalog', 'EntryGroups', 'eg');
  fs.mkdirSync(groupDir, {recursive: true});
  fs.writeFileSync(path.join(groupDir, 'stale_local.yaml'), 'version: "0.2.0.dev0/google"\n');
  return spyOn(pullKcMod, 'pullKnowledgeCatalog')
      .mockImplementation(async () => ({
                            models: [{name: 'commerce', entities: []}],
                            warnings: [],
                          }) as any);
}

describe('pull', () => {
  test('runs the model leg, then the bundle leg', async () => {
    const model = emptyCatalog();
    const bundle = spyOn(catalogToOkfMod, 'catalogToOkf')
                       .mockImplementation(async () => 0);

    expect(await pull({})).toBe(0);

    expect(model).toHaveBeenCalledTimes(1);
    expect(bundle).toHaveBeenCalledTimes(1);
    expect(model.mock.invocationCallOrder[0])
        .toBeLessThan(bundle.mock.invocationCallOrder[0]);
  });

  test('forwards --dry-run to the bundle leg', async () => {
    emptyCatalog();
    const bundle = spyOn(catalogToOkfMod, 'catalogToOkf')
                       .mockImplementation(async () => 0);

    expect(await pull({dryRun: true})).toBe(0);
    expect(bundle.mock.calls[0][2]).toEqual({dryRun: true});
  });

  // Writing the bundle after the model leg has already failed would leave the
  // workspace half-pulled.
  test('does not touch the bundle when the model leg fails', async () => {
    conflictingCatalog();
    const bundle = spyOn(catalogToOkfMod, 'catalogToOkf')
                       .mockImplementation(async () => 0);

    expect(await pull({})).toBe(1);
    expect(bundle).not.toHaveBeenCalled();
  });
});

describe('push', () => {
  // The model leg's checks can reject the whole command, so failing before
  // the bundle's batches go out leaves less half-applied.
  test('does not push the bundle when the model leg fails', async () => {
    const groupDir = path.join(dir, 'catalog', 'EntryGroups', 'eg');
    fs.mkdirSync(groupDir, {recursive: true});
    // A model file that does not load fails the model leg.
    fs.writeFileSync(path.join(groupDir, 'commerce.yaml'), 'not: [a, valid, model\n');
    const bundle = spyOn(okfToCatalogMod, 'okfToCatalog')
                       .mockImplementation(async () => 0);

    expect(await push({})).toBe(1);
    expect(bundle).not.toHaveBeenCalled();
  });
});

describe('other scopes are unaffected', () => {
  test('an entryGroup scope reaches neither OKF leg', async () => {
    fs.writeFileSync(
        path.join(dir, 'catalog.yaml'), 'scope: entryGroup.test-project.us.eg\n');
    const toOkf = spyOn(catalogToOkfMod, 'catalogToOkf')
                      .mockImplementation(async () => 0);
    const fromOkf = spyOn(okfToCatalogMod, 'okfToCatalog')
                        .mockImplementation(async () => 0);
    const model = spyOn(pullKcMod, 'pullKnowledgeCatalog')
                      .mockImplementation(async () => ({models: [], warnings: []}) as any);
    spyOn(CatalogClient.prototype, 'listEntries')
        .mockImplementation(async function*() {});

    expect(await pull({})).toBe(0);

    expect(toOkf).not.toHaveBeenCalled();
    expect(fromOkf).not.toHaveBeenCalled();
    expect(model).not.toHaveBeenCalled();
  });
});
