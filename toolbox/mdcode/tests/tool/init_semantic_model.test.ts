// Tests that `kcmd init --semantic-model` provisions the destination entry
// group (src/tool/commands.ts, init()).
//
// The entry group is created at init -- not on push -- so a semantic-model push
// writes only entries, matching how the standard layout operates (its push
// creates entries, never the entry group). These tests spy on the catalog
// client so no network call is made and run init inside a temp working
// directory (it writes catalog.yaml + the layout dirs relative to cwd).

import {afterEach, beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {ApiResult} from '../../src/libts/gcp/api';
import {ApiContext} from '../../src/libts/gcp/context';
import {CatalogClient} from '../../src/libts/gcp/dataplex';
import {init} from '../../src/tool/commands';

const CTX = new ApiContext('test-project', 'us', 'test-token');

function ok<T>(result?: T): ApiResult<T> {
  return {status: 200, result};
}
function err(status: number, message: string): ApiResult<any> {
  return {status, message};
}

let dir = '';
let cwd = '';

beforeEach(() => {
  cwd = process.cwd();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcmd-init-'));
  process.chdir(dir);
  // init() resolves its context from gcloud; pin it to a hermetic value.
  spyOn(ApiContext, 'default').mockReturnValue(CTX);
  // init() prints the generated catalog.yaml; keep test output quiet.
  spyOn(console, 'log').mockImplementation(() => {});
  spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.chdir(cwd);
  if (dir) fs.rmSync(dir, {recursive: true, force: true});
  dir = '';
  mock.restore();
});


describe('init --semantic-model: entry-group provisioning', () => {
  test(
      'creates the destination entry group and the local layout dir',
      async () => {
        const group =
            spyOn(CatalogClient.prototype, 'createEntryGroup')
                .mockImplementation(async () => ok({name: 'sales-group'}));

        const code = await init({semanticModel: 'proj.us.sales-group'});

        expect(code).toBe(0);
        expect(group).toHaveBeenCalledTimes(1);
        const [project, location, entryGroupId] = group.mock.calls[0];
        expect(project).toBe('proj');
        expect(location).toBe('us');
        expect(entryGroupId).toBe('sales-group');
        expect(
            fs.existsSync(path.join('catalog', 'EntryGroups', 'sales-group')))
            .toBe(true);
        expect(fs.readFileSync('catalog.yaml', 'utf8'))
            .toContain('scope: semantic-model.proj.us.sales-group');
      });

  test('an already-existing entry group (409) is success', async () => {
    const group =
        spyOn(CatalogClient.prototype, 'createEntryGroup')
            .mockImplementation(async () => err(409, 'already exists'));

    const code = await init({semanticModel: 'proj.us.sales-group'});

    expect(code).toBe(0);
    expect(group).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join('catalog', 'EntryGroups', 'sales-group')))
        .toBe(true);
  });

  test('a fatal entry-group error fails init', async () => {
    const group =
        spyOn(CatalogClient.prototype, 'createEntryGroup')
            .mockImplementation(async () => err(403, 'permission denied'));

    const code = await init({semanticModel: 'proj.us.sales-group'});

    expect(code).toBe(1);
    expect(group).toHaveBeenCalledTimes(1);
    // The layout dir is not created when provisioning fails.
    expect(fs.existsSync(path.join('catalog', 'EntryGroups', 'sales-group')))
        .toBe(false);
  });
});
