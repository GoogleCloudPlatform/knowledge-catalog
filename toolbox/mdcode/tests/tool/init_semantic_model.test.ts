// Tests that `kcmd init --semantic-model` provisions the destination entry
// group and the custom types (src/tool/commands.ts, init()).
//
// Both are created at init -- not on push -- so a semantic-model push writes
// only entries, matching how the standard layout operates (its push creates
// entries, never the entry group). The types kcmd creates rather than
// references are declared in kc_custom_types.ts, which today holds the action,
// constraint and file-copy pairs. These tests spy on the catalog client so no
// network call is made, and run init inside a temp working directory (it writes
// catalog.yaml + the layout dirs relative to cwd).

import {afterEach, beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {ApiResult} from '../../src/libts/gcp/api';
import {ApiContext} from '../../src/libts/gcp/context';
import {CatalogClient} from '../../src/libts/gcp/dataplex';
import {CUSTOM_TYPES, FILE_COPY_TYPE_ID} from '../../src/libts/semantic/kc_custom_types';
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
  // A call no test stubs fails instead of reaching the network.
  spyOn(globalThis, 'fetch').mockImplementation((async () => {
    throw new Error('a test made a network call');
  }) as any);
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

  // Every workspace re-runs init once after an upgrade, and a bare push uses
  // default_profile.
  test('re-running init keeps default_profile and the file\'s comments',
       async () => {
         spyOn(CatalogClient.prototype, 'createEntryGroup')
             .mockImplementation(async () => err(409, 'already exists'));
         const before = '# The commerce workspace.\n' +
             'scope: semantic-model.proj.us.sales-group\n' +
             'default_profile: prod\n';
         fs.writeFileSync('catalog.yaml', before);

         expect(await init({semanticModel: 'proj.us.sales-group'})).toBe(0);
         expect(fs.readFileSync('catalog.yaml', 'utf8')).toBe(before);
       });

  // A profile chosen for another entry group's model does not apply here.
  test('init for another scope writes a new catalog.yaml', async () => {
    spyOn(CatalogClient.prototype, 'createEntryGroup')
        .mockImplementation(async () => ok({name: 'sales-group'}));
    fs.writeFileSync(
        'catalog.yaml',
        'scope: semantic-model.proj.us.old-group\ndefault_profile: prod\n');

    expect(await init({semanticModel: 'proj.us.sales-group'})).toBe(0);
    expect(fs.readFileSync('catalog.yaml', 'utf8'))
        .toBe('scope: semantic-model.proj.us.sales-group\n');
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

  test('provisions every registered custom type in the destination project',
       async () => {
    spyOn(CatalogClient.prototype, 'createEntryGroup')
        .mockImplementation(async () => ok({name: 'sales-group'}));
    const aspectType = spyOn(CatalogClient.prototype, 'createAspectType')
                           .mockImplementation(async () => ok({name: OP}));
    const entryType = spyOn(CatalogClient.prototype, 'createEntryType')
                          .mockImplementation(async () => ok({name: OP}));

    expect(await init({semanticModel: 'proj.us.sales-group'})).toBe(0);

    // Every registered type gets both halves. Both are custom, so both live in
    // the destination project at `global`, rather than beside the built-in
    // types or in the entry group's region.
    const ids = CUSTOM_TYPES.map(t => t.id);
    expect(ids).toContain('semantic-action');
    for (const spy of [aspectType, entryType]) {
      expect(spy).toHaveBeenCalledTimes(ids.length);
      expect(spy.mock.calls.map(c => c[2])).toEqual(ids);
      for (const [project, location] of spy.mock.calls) {
        expect(project).toBe('proj');
        expect(location).toBe('global');
      }
    }
    // The entry type requires the aspect type, so the server rejects it while
    // the aspect type's create is still running.
    for (let i = 0; i < ids.length; i++) {
      expect(aspectType.mock.invocationCallOrder[i])
          .toBeLessThan(entryType.mock.invocationCallOrder[i]);
    }
  });

  test('waits for each type-creation operation to finish', async () => {
    spyOn(CatalogClient.prototype, 'createEntryGroup')
        .mockImplementation(async () => ok({name: 'sales-group'}));
    // Each aspect type is still being created when the call returns, under
    // an operation of its own, and reports done on its second poll.
    let created = 0;
    spyOn(CatalogClient.prototype, 'createAspectType')
        .mockImplementation(async () => ok({name: `op-${++created}`, done: false}));
    const polls = new Map<string, number>();
    spyOn(CatalogClient.prototype, 'getOperation')
        .mockImplementation(async (name: string) => {
          const n = (polls.get(name) ?? 0) + 1;
          polls.set(name, n);
          return ok({name, done: n > 1});
        });
    // Types whose entry type was created while the aspect type it requires was
    // still being created, which the server rejects.
    const premature: string[] = [];
    spyOn(CatalogClient.prototype, 'createEntryType')
        .mockImplementation(async (_p: string, _l: string, typeId: string) => {
          if ((polls.get(`op-${created}`) ?? 0) < 2) premature.push(typeId);
          // Already finished, so the next type starts without a poll delay.
          return ok({name: OP, done: true});
        });

    expect(await init({semanticModel: 'proj.us.sales-group'})).toBe(0);
    expect(premature).toEqual([]);
    expect(created).toBe(CUSTOM_TYPES.length);
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
    // patch names the template field to bring it up to date.
    expect(update).toHaveBeenCalledTimes(CUSTOM_TYPES.length);
    expect(update.mock.calls[0][4]).toContain('metadata_template');
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

  test('init survives lacking permission to create the action types',
       async () => {
    spyOn(CatalogClient.prototype, 'createEntryGroup')
        .mockImplementation(async () => ok({name: 'sales-group'}));
    spyOn(CatalogClient.prototype, 'createAspectType')
        .mockImplementation(async (_p: any, _l: any, id: string) =>
            id === FILE_COPY_TYPE_ID ? ok({}) :
                                       err(403, 'permission denied'));

    // Actions are one optional construct: a caller who will never declare one
    // must still be able to init, push and pull.
    expect(await init({semanticModel: 'proj.us.sales-group'})).toBe(0);
    expect(fs.existsSync(path.join('catalog', 'EntryGroups', 'sales-group')))
        .toBe(true);
  });

  test('init fails when creating the file-copy type is denied', async () => {
    spyOn(CatalogClient.prototype, 'createEntryGroup')
        .mockImplementation(async () => ok({name: 'sales-group'}));
    spyOn(CatalogClient.prototype, 'createAspectType')
        .mockImplementation(async (_p: any, _l: any, id: string) =>
            id === FILE_COPY_TYPE_ID ? err(403, 'permission denied') :
                                       ok({}));
    spyOn(CatalogClient.prototype, 'getAspectType')
        .mockImplementation(async () => err(404, 'not found'));
    const errors: string[] = [];
    spyOn(console, 'error').mockImplementation((...args: any[]) => {
      errors.push(args.join(' '));
    });

    // Every push stores the model file with this type, so init cannot leave
    // it uncreated.
    expect(await init({semanticModel: 'proj.us.sales-group'})).toBe(1);
    expect(errors.join('\n'))
        .toContain(
            'no permission to create aspect type \'semantic-model-file\' in ' +
            'project \'proj\'');
  });

  // A teammate in a project an administrator set up may publish entries but
  // not create or update types. The types exist, so push has what it needs.
  test('init finishes when the types exist and every create and update is ' +
           'refused',
       async () => {
         spyOn(CatalogClient.prototype, 'createEntryGroup')
             .mockImplementation(async () => err(409, 'already exists'));
         spyOn(CatalogClient.prototype, 'createAspectType')
             .mockImplementation(async () => err(403, 'permission denied'));
         spyOn(CatalogClient.prototype, 'updateAspectType')
             .mockImplementation(async () => err(403, 'permission denied'));
         spyOn(CatalogClient.prototype, 'createEntryType')
             .mockImplementation(async () => err(403, 'permission denied'));
         const aspectLookup =
             spyOn(CatalogClient.prototype, 'getAspectType')
                 .mockImplementation(async () => ok<any>({}));
         const entryLookup = spyOn(CatalogClient.prototype, 'getEntryType')
                                 .mockImplementation(async () => ok<any>({}));
         const warned: string[] = [];
         spyOn(console, 'warn').mockImplementation((...args: any[]) => {
           warned.push(args.join(' '));
         });

         expect(await init({semanticModel: 'proj.us.sales-group'})).toBe(0);
         expect(fs.existsSync('catalog.yaml')).toBe(true);
         // Only the required type is looked up.
         expect(aspectLookup.mock.calls.map(c => c[2])).toEqual([
           FILE_COPY_TYPE_ID,
         ]);
         expect(entryLookup.mock.calls.map(c => c[2])).toEqual([
           FILE_COPY_TYPE_ID,
         ]);
         // The refused call is the update of a type that exists.
         expect(warned).toContain(
             'Warning: no permission to update the existing aspect type ' +
             '\'semantic-model-file\' in project \'proj\' (permission ' +
             'denied); left it unchanged');
       });

  test('init finishes when the file-copy entry type exists and its create ' +
           'is refused',
       async () => {
         spyOn(CatalogClient.prototype, 'createEntryGroup')
             .mockImplementation(async () => ok({name: 'sales-group'}));
         spyOn(CatalogClient.prototype, 'createEntryType')
             .mockImplementation(async (_p: any, _l: any, id: string) =>
                 id === FILE_COPY_TYPE_ID ? err(403, 'permission denied') :
                                            ok({name: OP}));
         spyOn(CatalogClient.prototype, 'getEntryType')
             .mockImplementation(async () => ok<any>({}));

         expect(await init({semanticModel: 'proj.us.sales-group'})).toBe(0);
         expect(fs.existsSync('catalog.yaml')).toBe(true);
       });

  test('init fails when the file-copy entry type is missing and its create ' +
           'is refused',
       async () => {
         spyOn(CatalogClient.prototype, 'createEntryGroup')
             .mockImplementation(async () => ok({name: 'sales-group'}));
         spyOn(CatalogClient.prototype, 'createEntryType')
             .mockImplementation(async (_p: any, _l: any, id: string) =>
                 id === FILE_COPY_TYPE_ID ? err(403, 'permission denied') :
                                            ok({name: OP}));
         spyOn(CatalogClient.prototype, 'getEntryType')
             .mockImplementation(async () => err(404, 'not found'));
         const errors: string[] = [];
         spyOn(console, 'error').mockImplementation((...args: any[]) => {
           errors.push(args.join(' '));
         });

         expect(await init({semanticModel: 'proj.us.sales-group'})).toBe(1);
         expect(errors.join('\n'))
             .toContain(
                 'no permission to create entry type \'semantic-model-file\'');
         expect(fs.existsSync('catalog.yaml')).toBe(false);
       });

  test('a type refused for lack of permission does not skip the next one',
       async () => {
    // The refusals differ per type and per operation, so a caller refused one
    // may well be allowed the next. Giving up at the first one left a type
    // uncreated that nothing was stopping.
    spyOn(CatalogClient.prototype, 'createEntryGroup')
        .mockImplementation(async () => ok({name: 'sales-group'}));
    const first = CUSTOM_TYPES[0].id;
    const aspectType =
        spyOn(CatalogClient.prototype, 'createAspectType')
            .mockImplementation(async (_p: any, _l: any, id: string) =>
                id === first ? err(403, 'permission denied') :
                               ok({name: id}));

    expect(await init({semanticModel: 'proj.us.sales-group'})).toBe(0);

    // Every type is attempted, including the ones after the refusal.
    expect(aspectType.mock.calls.map(c => c[2])).toEqual(
        CUSTOM_TYPES.map(t => t.id));
  });

  test('a fatal action-type error fails init', async () => {
    spyOn(CatalogClient.prototype, 'createEntryGroup')
        .mockImplementation(async () => ok({name: 'sales-group'}));
    spyOn(CatalogClient.prototype, 'createAspectType')
        .mockImplementation(async () => err(400, 'bad metadata template'));

    expect(await init({semanticModel: 'proj.us.sales-group'})).toBe(1);
  });

  // A teammate without create permission may be refused the create of an
  // entry group someone else set up.
  test('a refused create of an entry group that exists is success',
       async () => {
         spyOn(CatalogClient.prototype, 'createEntryGroup')
             .mockImplementation(async () => err(403, 'permission denied'));
         const lookup = spyOn(CatalogClient.prototype, 'getEntryGroup')
                            .mockImplementation(async () => ok<any>({}));

         expect(await init({semanticModel: 'proj.us.sales-group'})).toBe(0);
         expect(lookup.mock.calls[0]).toEqual(['proj', 'us', 'sales-group']);
         expect(fs.existsSync('catalog.yaml')).toBe(true);
       });

  test('a fatal entry-group error fails init', async () => {
    const group =
        spyOn(CatalogClient.prototype, 'createEntryGroup')
            .mockImplementation(async () => err(403, 'permission denied'));
    // The group is not there, so the refusal is fatal.
    spyOn(CatalogClient.prototype, 'getEntryGroup')
        .mockImplementation(async () => err(404, 'not found'));

    const code = await init({semanticModel: 'proj.us.sales-group'});

    expect(code).toBe(1);
    expect(group).toHaveBeenCalledTimes(1);
    // The layout dir is not created when provisioning fails.
    expect(fs.existsSync(path.join('catalog', 'EntryGroups', 'sales-group')))
        .toBe(false);
  });
});
