// Tests that `kcmd init --semantic-model` provisions the destination entry
// group and the custom types (src/tool/commands.ts, init()).
//
// Both are created at init -- not on push -- so a semantic-model push writes
// only entries, matching how the standard layout operates (its push creates
// entries, never the entry group). The types kcmd creates rather than
// references are declared in kc_custom_types.ts, which today holds the action
// pair and the relationship pair. The tests below assert
// over CUSTOM_TYPES rather than naming those two, so adding a third type does
// not need them rewritten. They spy on the catalog client so no network call is
// made and run init
// inside a temp working directory (it writes catalog.yaml + the layout dirs
// relative to cwd).

import {afterEach, beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {ApiResult} from '../../src/libts/gcp/api';
import {ApiContext} from '../../src/libts/gcp/context';
import {CatalogClient} from '../../src/libts/gcp/dataplex';
import {CUSTOM_TYPES} from '../../src/libts/semantic/kc_custom_types';
import {init} from '../../src/tool/commands';

const CTX = new ApiContext('test-project', 'us', 'test-token');

// The operation name a type create returns and `getOperation` is polled with.
const OP = 'projects/proj/locations/global/operations/op-1';

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
  spyOn(console, 'warn').mockImplementation(() => {});
  // Provisioning the custom types succeeds by default; the tests that
  // care about it re-stub these. Each create returns a long-running operation,
  // so `getOperation` has to answer too.
  spyOn(CatalogClient.prototype, 'createAspectType')
      .mockImplementation(async () => ok({name: OP, done: false}));
  spyOn(CatalogClient.prototype, 'createEntryType')
      .mockImplementation(async () => ok({name: OP, done: false}));
  spyOn(CatalogClient.prototype, 'getOperation')
      .mockImplementation(async () => ok({name: OP, done: true}));
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

  test('provisions every custom type in the destination project', async () => {
    spyOn(CatalogClient.prototype, 'createEntryGroup')
        .mockImplementation(async () => ok({name: 'sales-group'}));
    const aspectType = spyOn(CatalogClient.prototype, 'createAspectType')
                           .mockImplementation(async () => ok({name: OP}));
    const entryType = spyOn(CatalogClient.prototype, 'createEntryType')
                          .mockImplementation(async () => ok({name: OP}));

    expect(await init({semanticModel: 'proj.us.sales-group'})).toBe(0);

    // CUSTOM_TYPES is the whole of what kcmd provisions, so init creates that
    // list and nothing else -- one entry type and one aspect type per record.
    const ids = CUSTOM_TYPES.map(t => t.id);
    for (const spy of [aspectType, entryType]) {
      expect(spy).toHaveBeenCalledTimes(ids.length);
      // Every type is custom, so it lives in the destination project at
      // `global` -- not beside the built-in types, and not in the entry group's
      // region.
      for (const call of spy.mock.calls) {
        const [project, location] = call;
        expect(project).toBe('proj');
        expect(location).toBe('global');
      }
      expect(spy.mock.calls.map(c => c[2])).toEqual(ids);
    }
    // An entry type requires its own aspect type, so the server rejects it
    // while that aspect type's create is still running.
    ids.forEach((_, i) => {
      expect(aspectType.mock.invocationCallOrder[i])
          .toBeLessThan(entryType.mock.invocationCallOrder[i]);
    });
  });

  test('waits for each type-creation operation to finish', async () => {
    spyOn(CatalogClient.prototype, 'createEntryGroup')
        .mockImplementation(async () => ok({name: 'sales-group'}));
    // Each aspect type is still being created when the call returns, and gets
    // its own operation name so the polling below is per type rather than
    // shared.
    let created = 0;
    const running = new Set<string>();
    spyOn(CatalogClient.prototype, 'createAspectType')
        .mockImplementation(async () => {
          const name = `${OP}-${++created}`;
          running.add(name);
          return ok({name, done: false});
        });
    // An operation reports done on its SECOND poll, so a caller that does not
    // wait sees it still running.
    const polls = new Map<string, number>();
    spyOn(CatalogClient.prototype, 'getOperation')
        .mockImplementation(async (name: string) => {
          const n = (polls.get(name) ?? 0) + 1;
          polls.set(name, n);
          if (n > 1) running.delete(name);
          return ok({name, done: n > 1});
        });
    // How many aspect-type creates were still running each time an entry type
    // was created. An entry type requires its aspect type, so the server
    // rejects it while that create is in flight; anything but zero means init
    // did not wait.
    const stillRunning: number[] = [];
    spyOn(CatalogClient.prototype, 'createEntryType')
        .mockImplementation(async () => {
          stillRunning.push(running.size);
          return ok({name: OP, done: true});
        });

    expect(await init({semanticModel: 'proj.us.sales-group'})).toBe(0);
    expect(stillRunning).toEqual(CUSTOM_TYPES.map(() => 0));
    // Each aspect operation really was polled to completion, not skipped.
    expect([...polls.values()]).toEqual(CUSTOM_TYPES.map(() => 2));
  });

  test('an already-existing aspect type is patched with the current template',
       async () => {
    spyOn(CatalogClient.prototype, 'createEntryGroup')
        .mockImplementation(async () => ok({name: 'sales-group'}));
    spyOn(CatalogClient.prototype, 'createAspectType')
        .mockImplementation(async () => err(409, 'already exists'));
    const update = spyOn(CatalogClient.prototype, 'updateAspectType')
                       .mockImplementation(async () => ok({name: OP}));
    // The entry type is already there too, which is not an error.
    spyOn(CatalogClient.prototype, 'createEntryType')
        .mockImplementation(async () => err(409, 'already exists'));

    expect(await init({semanticModel: 'proj.us.sales-group'})).toBe(0);

    // A project provisioned by an earlier kcmd holds an older template, so the
    // patch names the template field to bring it up to date -- for every custom
    // type, since any of them may have grown a field.
    expect(update).toHaveBeenCalledTimes(CUSTOM_TYPES.length);
    for (const call of update.mock.calls) {
      expect(call[4]).toContain('metadata_template');
    }
  });

  test('a rejected template patch leaves the existing type and finishes init',
       async () => {
    spyOn(CatalogClient.prototype, 'createEntryGroup')
        .mockImplementation(async () => ok({name: 'sales-group'}));
    spyOn(CatalogClient.prototype, 'createAspectType')
        .mockImplementation(async () => err(409, 'already exists'));
    // What an OLDER kcmd sees against a project a newer one provisioned: its
    // template lacks the newer fields, so the patch is a field removal and
    // Dataplex refuses it.
    spyOn(CatalogClient.prototype, 'updateAspectType')
        .mockImplementation(
            async () => err(400, 'backwards-incompatible template change'));
    const entryType = spyOn(CatalogClient.prototype, 'createEntryType')
                          .mockImplementation(async () => err(409, 'exists'));
    // One warning per type whose patch was refused.
    const warned: string[] = [];
    spyOn(console, 'warn').mockImplementation((...args: any[]) => {
      warned.push(args.join(' '));
    });

    // The type already there is the one published entries depend on, so init
    // reports the refusal and carries on rather than abandoning a workspace
    // whose entry group it has already created.
    expect(await init({semanticModel: 'proj.us.sales-group'})).toBe(0);
    expect(entryType).toHaveBeenCalledTimes(CUSTOM_TYPES.length);
    expect(fs.existsSync(path.join('catalog', 'EntryGroups', 'sales-group')))
        .toBe(true);
    expect(warned.some(m => m.includes('unchanged'))).toBe(true);
  });

  test('init survives lacking permission to create the custom types',
       async () => {
    spyOn(CatalogClient.prototype, 'createEntryGroup')
        .mockImplementation(async () => ok({name: 'sales-group'}));
    spyOn(CatalogClient.prototype, 'createAspectType')
        .mockImplementation(async () => err(403, 'permission denied'));

    // Every custom type backs an optional construct -- an action, a
    // many-to-many relationship -- so a caller who will never declare one must
    // still be able to init, push and pull.
    expect(await init({semanticModel: 'proj.us.sales-group'})).toBe(0);
    expect(fs.existsSync(path.join('catalog', 'EntryGroups', 'sales-group')))
        .toBe(true);
  });

  test('a fatal custom-type error fails init', async () => {
    spyOn(CatalogClient.prototype, 'createEntryGroup')
        .mockImplementation(async () => ok({name: 'sales-group'}));
    spyOn(CatalogClient.prototype, 'createAspectType')
        .mockImplementation(async () => err(400, 'bad metadata template'));

    expect(await init({semanticModel: 'proj.us.sales-group'})).toBe(1);
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
