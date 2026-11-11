// Tests that pull and push move the context set's display name and
// description between catalog.yaml and the entry group, in semantic-model,
// standard entry-group and OKF workspaces (src/tool/commands.ts).

import {afterEach, beforeEach, describe, expect, Mock, mock, spyOn, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as kcmd from '../../src/libts';
import {readContextSetMetadata} from '../../src/libts/context_set';
import {ApiContext} from '../../src/libts/gcp/context';
import * as crm from '../../src/libts/gcp/crm';
import {CatalogClient} from '../../src/libts/gcp/dataplex';
import * as bqLeg from '../../src/libts/semantic/deploy_bigquery';
import * as kc from '../../src/libts/semantic/deploy_knowledge_catalog';
import * as pullKc from '../../src/libts/semantic/pull_kc';
import * as commands from '../../src/tool/commands';

import {passGraphChecks} from '../libts/mocks';
import {CTX, kcResult, PREPARED, writeScope} from './two_phase/harness';

const SEMANTIC_SCOPE = 'scope: semantic-model.test-project.us.commerce_eg\n';
const ENTRY_GROUP_SCOPE = 'scope: entryGroup.test-project.us.commerce_eg\n';
const GROUP = 'projects/test-project/locations/us/entryGroups/commerce_eg';

let dir = '';
let cwd = '';
let printed: string[] = [];
let errors: string[] = [];
let events: string[] = [];
let group: Record<string, unknown> = {};
let updateGroup: Mock<(...a: any[]) => any>;

beforeEach(() => {
  cwd = process.cwd();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcmd-context-set-cmd-'));
  process.chdir(dir);
  printed = [];
  errors = [];
  events = [];
  group = {name: GROUP, displayName: 'Commerce', description: 'In KC.'};
  spyOn(console, 'log').mockImplementation((...a) => {
    printed.push(a.join(' '));
  });
  spyOn(console, 'warn').mockImplementation(() => {});
  spyOn(console, 'error').mockImplementation((...a) => {
    errors.push(a.join(' '));
  });
  spyOn(ApiContext, 'default').mockReturnValue(CTX);
  spyOn(globalThis, 'fetch').mockImplementation((async () => {
    throw new Error('a test made a network call');
  }) as any);
  spyOn(CatalogClient.prototype, 'getEntryGroup').mockImplementation(async () => {
    events.push('getEntryGroup');
    return {status: 200, result: group as any};
  });
  updateGroup = spyOn(CatalogClient.prototype, 'updateEntryGroup')
                    .mockImplementation(async (_p, _l, _g, patch) => {
                      events.push('updateEntryGroup');
                      group = {...group, ...patch};
                      return {status: 200, result: {name: `${GROUP}/op`}};
                    });
  spyOn(CatalogClient.prototype, 'getOperation')
      .mockImplementation(async () => ({status: 200, result: {done: true}}));
  // The file-copy type check push makes before a catalog write.
  spyOn(CatalogClient.prototype, 'getEntryType')
      .mockImplementation(async () => ({status: 200, result: {} as any}));
  spyOn(CatalogClient.prototype, 'getAspectType')
      .mockImplementation(async () => ({status: 200, result: {} as any}));
  spyOn(kc, 'preflightKnowledgeCatalog').mockImplementation(async () => {
    events.push('preflight');
    return {prepared: PREPARED as any, result: kcResult()};
  });
  spyOn(kc, 'applyKnowledgeCatalog').mockImplementation(async () => {
    events.push('apply');
    return kcResult();
  });
});

afterEach(() => {
  process.chdir(cwd);
  fs.rmSync(dir, {recursive: true, force: true});
  mock.restore();
});

// A semantic-model workspace whose catalog.yaml also holds `keys`, with the
// deployments `deployments` names (BigQuery graphs).
function semanticWorkspace(keys = '', deployments: string[] = []): void {
  writeScope(dir, {deployments});
  fs.writeFileSync('catalog.yaml', SEMANTIC_SCOPE + keys);
}


describe('semantic-model push', () => {
  test('writes a changed description after the catalog write', async () => {
    semanticWorkspace('description: Edited locally.\n');
    expect(await commands.push({skipSourceCheck: true})).toBe(0);
    expect(events).toEqual(
        ['preflight', 'apply', 'getEntryGroup', 'updateEntryGroup']);
    expect(updateGroup.mock.calls[0].slice(3)).toEqual(
        [{description: 'Edited locally.'}, ['description']]);
    expect(printed).toContain('Updated the context set\'s description.');
  });

  test('validate-only reports the change and writes nothing', async () => {
    semanticWorkspace('displayName: Shop\ndescription: In KC.\n');
    expect(await commands.push({skipSourceCheck: true, validateOnly: true}))
        .toBe(0);
    expect(updateGroup).not.toHaveBeenCalled();
    expect(events).not.toContain('apply');
    expect(printed).toContain('Would update the context set\'s display name.');
  });

  test('without the keys, the entry group is not read', async () => {
    semanticWorkspace();
    expect(await commands.push({skipSourceCheck: true})).toBe(0);
    expect(events).toEqual(['preflight', 'apply']);
  });

  test('an over-long description fails before any write', async () => {
    semanticWorkspace(`description: ${'d'.repeat(1025)}\n`);
    expect(await commands.push({skipSourceCheck: true})).toBe(1);
    expect(events).toEqual([]);
    expect(errors).toEqual([expect.stringContaining('1025 characters long')]);
  });

  test('updates the context set after every graph deploys', async () => {
    semanticWorkspace('description: Edited locally.\n', ['g']);
    passGraphChecks();
    const real = bqLeg.deployBigQuery;
    spyOn(bqLeg, 'deployBigQuery').mockImplementation(async (m, c, o) => {
      if (o?.validateOnly) return real(m, c, o);
      events.push('deploy');
      return {success: true, ddl: [], warnings: [], deployed: 1} as any;
    });
    expect(await commands.push({skipSourceCheck: true})).toBe(0);
    expect(events).toEqual(
        ['preflight', 'apply', 'deploy', 'getEntryGroup', 'updateEntryGroup']);
  });

  test('kcmd profiles reports an over-long description as push would',
       async () => {
         semanticWorkspace(`description: ${'d'.repeat(1025)}\n`);
         expect(await commands.profiles()).toBe(1);
         expect(errors.join('\n')).toContain('1025 characters long');
       });

  test('a refused update fails the push', async () => {
    semanticWorkspace('description: Edited locally.\n');
    updateGroup.mockImplementation(
        async () => ({status: 403, message: 'permission denied'}));
    expect(await commands.push({skipSourceCheck: true})).toBe(1);
    expect(errors).toEqual([
      'Error: updating context set \'test-project.us.commerce_eg\': ' +
          'permission denied',
    ]);
  });
});


describe('semantic-model pull', () => {
  test('sets the keys from the entry group, keeping the scope', async () => {
    semanticWorkspace('# Sales workspace.\ndescription: Stale.\n');
    spyOn(pullKc, 'pullKnowledgeCatalog')
        .mockImplementation(async () => ({models: [], warnings: []} as any));
    expect(await commands.pull()).toBe(0);
    expect(readContextSetMetadata('catalog.yaml'))
        .toEqual({displayName: 'Commerce', description: 'In KC.'});
    const text = fs.readFileSync('catalog.yaml', 'utf8');
    expect(text).toContain('# Sales workspace.');
    expect(text).toContain(SEMANTIC_SCOPE.trim());
    expect(printed).toContain(
        'Updated the context set\'s display name and description in ' +
        'catalog.yaml.');
  });

  test('a dry run leaves catalog.yaml as it is', async () => {
    semanticWorkspace();
    spyOn(pullKc, 'pullKnowledgeCatalog')
        .mockImplementation(async () => ({models: [], warnings: []} as any));
    expect(await commands.pull({dryRun: true})).toBe(0);
    expect(fs.readFileSync('catalog.yaml', 'utf8')).toBe(SEMANTIC_SCOPE);
    expect(printed).toContain(
        'Would update the context set\'s display name and description in ' +
        'catalog.yaml.');
  });
});


describe('entry-group workspace', () => {
  beforeEach(() => {
    fs.mkdirSync(path.join('catalog', 'EntryGroups', 'commerce_eg'),
                 {recursive: true});
  });

  test('push writes a changed display name after the entries', async () => {
    fs.writeFileSync('catalog.yaml', ENTRY_GROUP_SCOPE + 'displayName: Shop\n');
    spyOn(kcmd.CatalogSync.prototype, 'push').mockImplementation(async () => {
      events.push('sync.push');
      return {success: true} as any;
    });
    expect(await commands.push({})).toBe(0);
    expect(events.slice(-3))
        .toEqual(['sync.push', 'getEntryGroup', 'updateEntryGroup']);
    expect(updateGroup.mock.calls[0].slice(3))
        .toEqual([{displayName: 'Shop'}, ['displayName']]);
  });

  test('pull sets the keys after the entries', async () => {
    fs.writeFileSync('catalog.yaml', ENTRY_GROUP_SCOPE);
    spyOn(kcmd.CatalogSync.prototype, 'pull').mockImplementation(async () => {
      events.push('sync.pull');
      return {success: true} as any;
    });
    expect(await commands.pull()).toBe(0);
    // The first read is the manifest load's own look-up of the group.
    expect(events.slice(-2)).toEqual(['sync.pull', 'getEntryGroup']);
    expect(readContextSetMetadata('catalog.yaml'))
        .toEqual({displayName: 'Commerce', description: 'In KC.'});
  });
});


describe('OKF workspace', () => {
  const OKF_SCOPE = ENTRY_GROUP_SCOPE + 'layout: okf\n';
  // A bundle root whose own title, description and body differ from
  // catalog.yaml's, which push no longer reads for the context set.
  const INDEX = '---\nokf_version: "0.2"\ntitle: Bundle title\n' +
      'description: Bundle description.\n---\n# Bundle title\n\n' +
      'The bundle overview.\n';
  let updateEntry: Mock<(...a: any[]) => any>;

  beforeEach(() => {
    fs.mkdirSync('bundle', {recursive: true});
    fs.writeFileSync(path.join('bundle', 'index.md'), INDEX);
    spyOn(kcmd.CatalogSync.prototype, 'push').mockImplementation(async () => {
      events.push('sync.push');
      return {success: true} as any;
    });
    spyOn(crm, 'projectNumber').mockImplementation(async () => '123');
    updateEntry = spyOn(CatalogClient.prototype, 'updateEntry')
                      .mockImplementation(async () => {
                        events.push('updateEntry');
                        return {status: 200, result: {} as any};
                      });
  });

  test('push writes catalog.yaml\'s values, not the bundle root\'s, after the entries',
       async () => {
         fs.writeFileSync(
             'catalog.yaml', OKF_SCOPE + 'description: From catalog.yaml.\n');
         expect(await commands.push({})).toBe(0);
         expect(updateGroup.mock.calls.map(c => c.slice(3))).toEqual(
             [[{description: 'From catalog.yaml.'}, ['description']]]);
         expect(events.indexOf('sync.push'))
             .toBeLessThan(events.indexOf('updateEntryGroup'));
         // The bundle root's body is still the context set's overview.
         expect(JSON.stringify(updateEntry.mock.calls[0][0]))
             .toContain('The bundle overview.');
       });

  test('without the keys, push leaves the context set\'s name and description alone',
       async () => {
         fs.writeFileSync('catalog.yaml', OKF_SCOPE);
         expect(await commands.push({})).toBe(0);
         expect(updateGroup).not.toHaveBeenCalled();
       });

  test('a push that creates the context set gives it catalog.yaml\'s values',
       async () => {
         fs.writeFileSync(
             'catalog.yaml',
             OKF_SCOPE + 'displayName: Shop\ndescription: From catalog.yaml.\n');
         let created = false;
         spyOn(CatalogClient.prototype, 'getEntryGroup')
             .mockImplementation(async () => created ?
                                     {status: 200, result: group as any} :
                                     {status: 404, message: 'not found'});
         const create = spyOn(CatalogClient.prototype, 'createEntryGroup')
                            .mockImplementation(async () => {
                              created = true;
                              return {status: 200, result: {name: GROUP}};
                            });
         expect(await commands.push({})).toBe(0);
         expect<unknown>(create.mock.calls[0][3]).toEqual({
           type: 'context-set',
           displayName: 'Shop',
           description: 'From catalog.yaml.',
         });
         expect(updateGroup).not.toHaveBeenCalled();
       });

  test('a create whose operation fails stops push before any entry', async () => {
    fs.writeFileSync('catalog.yaml', OKF_SCOPE + 'description: d\n');
    spyOn(CatalogClient.prototype, 'getEntryGroup')
        .mockImplementation(async () => ({status: 404, message: 'not found'}));
    const op = 'projects/test-project/locations/us/operations/op-1';
    spyOn(CatalogClient.prototype, 'createEntryGroup')
        .mockImplementation(async () => ({status: 200, result: {name: op}}));
    spyOn(CatalogClient.prototype, 'getOperation')
        .mockImplementation(async () => ({
                              status: 200,
                              result: {
                                name: op,
                                done: true,
                                error: {code: 7, message: 'Permission denied'},
                              },
                            }));
    expect(await commands.push({})).toBe(1);
    expect(errors).toEqual([
      'Error: creating context set \'test-project.us.commerce_eg\': ' +
          'Permission denied',
    ]);
    expect(events).not.toContain('sync.push');
  });

  test('warns when an untyped index.md names what catalog.yaml does not', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    fs.writeFileSync('catalog.yaml', OKF_SCOPE);
    expect(await commands.push({})).toBe(0);
    expect(warn.mock.calls.map(c => String(c[0]))).toEqual([
      'Warning: bundle/index.md\'s \'title\' no longer sets the context ' +
          'set\'s display name; add \'displayName:\' to catalog.yaml, or run ' +
          'kcmd pull.',
      'Warning: bundle/index.md\'s \'description\' no longer sets the ' +
          'context set\'s description; add \'description:\' to catalog.yaml, ' +
          'or run kcmd pull.',
    ]);

    warn.mockClear();
    fs.writeFileSync(
        'catalog.yaml', OKF_SCOPE + 'displayName: Shop\ndescription: d\n');
    expect(await commands.push({})).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  test('a typed agents.md root gives no warning', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    fs.writeFileSync(
        path.join('bundle', 'agents.md'),
        '---\ntype: Knowledge Base Root\ntitle: Agents\n' +
            'description: The root entry.\n---\n# Agents\n\nThe overview.\n');
    fs.writeFileSync('catalog.yaml', OKF_SCOPE);
    expect(await commands.push({})).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  test('init without --pull leaves the keys unset and reads nothing more',
       async () => {
         fs.rmSync('bundle', {recursive: true, force: true});
         const pull = spyOn(kcmd.CatalogSync.prototype, 'pull');
         expect(await commands.init({
           format: 'okf',
           entryGroup: 'test-project.us.commerce_eg',
           pull: false,
         })).toBe(0);
         expect(pull).not.toHaveBeenCalled();
         expect(readContextSetMetadata('catalog.yaml')).toEqual({});
         // The one read is init's own check that the entry group exists.
         expect(events.filter(e => e === 'getEntryGroup')).toHaveLength(1);
       });

  test('init of an existing context set sets the keys', async () => {
    fs.rmSync('bundle', {recursive: true, force: true});
    spyOn(kcmd.CatalogSync.prototype, 'pull')
        .mockImplementation(async () => ({success: true} as any));
    expect(await commands.init(
               {format: 'okf', entryGroup: 'test-project.us.commerce_eg'}))
        .toBe(0);
    expect(readContextSetMetadata('catalog.yaml'))
        .toEqual({displayName: 'Commerce', description: 'In KC.'});
  });

  test('pull sets the keys after the bundle', async () => {
    fs.writeFileSync('catalog.yaml', OKF_SCOPE);
    spyOn(kcmd.CatalogSync.prototype, 'pull').mockImplementation(async () => {
      events.push('sync.pull');
      return {success: true} as any;
    });
    expect(await commands.pull()).toBe(0);
    expect(events.slice(-2)).toEqual(['sync.pull', 'getEntryGroup']);
    expect(readContextSetMetadata('catalog.yaml'))
        .toEqual({displayName: 'Commerce', description: 'In KC.'});
    expect(fs.readFileSync('catalog.yaml', 'utf8')).toContain('layout: okf');
  });
});
