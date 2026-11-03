// Tests that pull and push move the context set's display name and
// description between catalog.yaml and the entry group, in a semantic-model
// workspace and in a standard entry-group workspace (src/tool/commands.ts).

import {afterEach, beforeEach, describe, expect, Mock, mock, spyOn, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as kcmd from '../../src/libts';
import {readContextSetMetadata} from '../../src/libts/context_set';
import {ApiContext} from '../../src/libts/gcp/context';
import {CatalogClient} from '../../src/libts/gcp/dataplex';
import * as kc from '../../src/libts/semantic/deploy_knowledge_catalog';
import * as pullKc from '../../src/libts/semantic/pull_kc';
import * as commands from '../../src/tool/commands';

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

// A semantic-model workspace whose catalog.yaml also holds `keys`.
function semanticWorkspace(keys = ''): void {
  writeScope(dir, {});
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
    spyOn(kcmd.CatalogSync.prototype, 'pull')
        .mockImplementation(async () => ({success: true} as any));
    expect(await commands.pull()).toBe(0);
    expect(readContextSetMetadata('catalog.yaml'))
        .toEqual({displayName: 'Commerce', description: 'In KC.'});
  });
});
