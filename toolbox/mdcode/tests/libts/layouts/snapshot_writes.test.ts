// Tests for writing several entries in one call (CatalogSnapshot.saveEntries
// and deleteEntries, the layouts' batch methods) and for the workspace lock
// (src/libts/lock.ts). Runs against real temp workspaces. Opening an
// entry-group workspace looks the group up; the lookup is stubbed.

import {afterEach, beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'yaml';

import {ApiContext} from '../../../src/libts/gcp/context';
import {CatalogClient} from '../../../src/libts/gcp/dataplex';
import {LOCK_FILE, withWorkspaceLock} from '../../../src/libts/lock';
import {CatalogSnapshot} from '../../../src/libts/snapshot';

const CTX = new ApiContext('test-project', 'us', 'test-token');

let dir = '';

function entryFile(name: string): string {
  return path.join(dir, 'catalog', `${name}.yaml`);
}

function writeWorkspace(group = 'test_eg'): void {
  fs.writeFileSync(
      path.join(dir, 'catalog.yaml'), `scope: entryGroup.test-project.us.${group}\n`);
  fs.mkdirSync(path.join(dir, 'catalog'), {recursive: true});
  for (const name of ['orders', 'customers']) {
    fs.writeFileSync(
        entryFile(name), yaml.stringify({name, type: 'test-project.us.table'}));
  }
}

async function open(): Promise<CatalogSnapshot> {
  return CatalogSnapshot.fromPath(dir, CTX);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcmd-writes-'));
  spyOn(console, 'warn').mockImplementation(() => {});
  spyOn(CatalogClient.prototype, 'getEntryGroup')
      .mockImplementation((async (p: string, l: string, id: string) => ({
                             status: 200,
                             result: {
                               name: `projects/${p}/locations/${
                                   l}/entryGroups/${id}`
                             },
                           })) as any);
});

afterEach(() => {
  fs.rmSync(dir, {recursive: true, force: true});
  mock.restore();
});

describe('CatalogSnapshot.saveEntries', () => {
  test('applies items in order and reports each, in order', async () => {
    writeWorkspace();
    const snapshot = await open();
    const results = await snapshot.saveEntries([
      {name: 'refunds', type: 'test-project.us.table', resource: {}},
      {name: 'orders', type: 'test-project.us.table',
       resource: {description: 'Orders.'}},
      {name: '../escape', type: 'test-project.us.table', resource: {}},
    ]);

    expect(results.map(r => [r.name, r.ok])).toEqual([
      ['refunds', true], ['orders', true], ['../escape', false],
    ]);
    expect(results[2].error).toContain('points outside the catalog folder');
    expect(fs.existsSync(entryFile('refunds'))).toBe(true);
    expect(yaml.parse(fs.readFileSync(entryFile('orders'), 'utf8'))
               .resource.description)
        .toBe('Orders.');
  });

  test('fails a second item for the same entry and applies the first',
       async () => {
         writeWorkspace();
         const snapshot = await open();
         const results = await snapshot.saveEntries([
           {name: 'orders', type: 'test-project.us.table',
            resource: {description: 'first'}},
           {name: 'orders', type: 'test-project.us.table',
            resource: {description: 'second'}},
         ]);

         expect(results[0].ok).toBe(true);
         expect(results[1]).toEqual({
           name: 'orders',
           ok: false,
           error: 'entry \'orders\' appears more than once in this call; ' +
               'merge its changes into one item',
         });
         expect(yaml.parse(fs.readFileSync(entryFile('orders'), 'utf8'))
                    .resource.description)
             .toBe('first');
       });

  test('refuses an update that changes the entry type', async () => {
    writeWorkspace();
    const snapshot = await open();
    const [result] = await snapshot.saveEntries(
        [{name: 'orders', type: 'test-project.us.view', resource: {}}]);

    expect(result.ok).toBe(false);
    expect(result.error)
        .toBe('entry \'orders\' is a test-project.us.table; an update cannot ' +
              'change its type to test-project.us.view');
  });

  test('refuses creates in a workspace of ingested entries, not updates',
       async () => {
         writeWorkspace('@bigquery');
         const snapshot = await open();
         const results = await snapshot.saveEntries([
           {name: 'new_table', type: 'test-project.us.table', resource: {}},
           {name: 'orders', type: 'test-project.us.table',
            resource: {description: 'kept'}},
         ]);

         expect(results[0]).toEqual({
           name: 'new_table',
           ok: false,
           error: 'Entry cannot be created as entries are ingested.',
         });
         expect(results[1].ok).toBe(true);
         expect(fs.existsSync(entryFile('new_table'))).toBe(false);
       });

  test('takes the workspace lock and releases it', async () => {
    writeWorkspace();
    const snapshot = await open();
    const lock = path.join(dir, LOCK_FILE);
    spyOn(snapshot.layout, 'saveEntries').mockImplementation(async entries => {
      expect(fs.readFileSync(lock, 'utf8').trim()).toBe(String(process.pid));
      return entries.map(e => ({name: e.name, ok: true}));
    });

    await snapshot.saveEntries([{name: 'orders', type: 'test-project.us.table', resource: {}}]);
    expect(fs.existsSync(lock)).toBe(false);
  });
});

describe('CatalogSnapshot.deleteEntries', () => {
  test('deletes each name and reports an unknown one', async () => {
    writeWorkspace();
    const snapshot = await open();
    const results = await snapshot.deleteEntries(['orders', 'nope', 'orders']);

    expect(results.map(r => [r.name, r.ok])).toEqual([
      ['orders', true], ['nope', false], ['orders', false],
    ]);
    expect(results[1].error).toBe('Entry not found: nope');
    expect(results[2].error).toContain('appears more than once');
    expect(fs.existsSync(entryFile('orders'))).toBe(false);
    expect(fs.existsSync(entryFile('customers'))).toBe(true);
  });

  test('refuses every delete in a workspace of ingested entries', async () => {
    writeWorkspace('@bigquery');
    const snapshot = await open();
    const [result] = await snapshot.deleteEntries(['orders']);

    expect(result.error).toBe('Entry cannot be deleted as entries are ingested.');
    expect(fs.existsSync(entryFile('orders'))).toBe(true);
  });
});

describe('the semantic-model layout before it exposes entries', () => {
  test('fails every item with its own message', async () => {
    fs.writeFileSync(
        path.join(dir, 'catalog.yaml'),
        'scope: semantic-model.test-project.us.commerce_eg\n');
    const snapshot = await open();

    const saved = await snapshot.saveEntries(
        [{name: 'orders', type: 'dataplex-types.global.semantic-entity', resource: {}}]);
    const deleted = await snapshot.deleteEntries(['orders']);

    expect(saved[0].error).toContain('does not support writing per-entry files yet');
    expect(deleted[0].error).toContain('does not support deleting per-entry files yet');
  });
});

describe('withWorkspaceLock', () => {
  const lockPath = () => path.join(dir, LOCK_FILE);

  test('fails while another live process holds the lock', async () => {
    // The parent of the test runner is alive for the whole test.
    fs.writeFileSync(lockPath(), `${process.ppid}\n`);
    let ran = false;

    await expect(withWorkspaceLock(dir, async () => {
      ran = true;
    })).rejects.toThrow(`the workspace is busy: kcmd process ${process.ppid}`);
    expect(ran).toBe(false);
    expect(fs.readFileSync(lockPath(), 'utf8').trim()).toBe(String(process.ppid));
  });

  test('takes over a lock whose process is gone', async () => {
    const child = Bun.spawnSync({cmd: ['true']});
    expect(child.exitCode).toBe(0);
    fs.writeFileSync(lockPath(), `${child.pid}\n`);

    expect(await withWorkspaceLock(dir, async () => 'done')).toBe('done');
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  test('treats a fresh lock with no process id as busy, an old one as stale',
       async () => {
         fs.writeFileSync(lockPath(), '');
         await expect(withWorkspaceLock(dir, async () => {}))
             .rejects.toThrow('another kcmd process is writing it');

         const past = new Date(Date.now() - 60_000);
         fs.utimesSync(lockPath(), past, past);
         expect(await withWorkspaceLock(dir, async () => 1)).toBe(1);
       });

  test('releases the lock when the work throws', async () => {
    await expect(withWorkspaceLock(dir, async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(fs.existsSync(lockPath())).toBe(false);
  });
});
