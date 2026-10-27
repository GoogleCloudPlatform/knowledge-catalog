// Tests for `kcmd entry` (src/tool/entry_commands.ts): listing and reading
// entries as JSON. Each test runs in a temp workspace. The standard-layout
// workspace names a custom entry group, so opening it looks the group up; the
// lookup is stubbed, every other network call fails the test, and no gcloud
// command may run, since `kcmd entry` uses a deferred API context.

import {afterEach, beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import * as cp from 'child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'yaml';

import {CatalogClient} from '../../src/libts/gcp/dataplex';
import * as sqlParser from '../../src/libts/semantic/sql_parser';
import {entry, matchesType} from '../../src/tool/entry_commands';

const MAIN = path.join(process.cwd(), 'src', 'tool', 'main.ts');

const ORDERS = {
  name: 'orders',
  type: 'test-project.us.table',
  resource: {displayName: 'orders', description: 'One row per order.'},
  aspects: {'test-project.us.notes': {text: 'hello'}},
};
const REFUNDS = {
  name: 'sub/refunds',
  type: 'dataplex-types.global.generic',
  resource: {description: 'One row per refund.'},
};

const MODEL_YAML = `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    entities:
      - name: Customer
        primary_key: [key]
        fields:
          - { name: key, label: Customer ID }
`;

let dir = '';
let cwd = '';
let out: string[] = [];
let err: string[] = [];

function writeStandardWorkspace(
    scope = 'entryGroup.test-project.us.test_eg'): void {
  fs.writeFileSync('catalog.yaml', `scope: ${scope}\n`);
  fs.mkdirSync(path.join('catalog', 'sub'), {recursive: true});
  fs.writeFileSync(path.join('catalog', 'orders.yaml'), yaml.stringify(ORDERS));
  fs.writeFileSync(
      path.join('catalog', 'sub', 'refunds.yaml'), yaml.stringify(REFUNDS));
}

function writeSemanticWorkspace(): void {
  fs.writeFileSync(
      'catalog.yaml', 'scope: semantic-model.test-project.us.commerce_eg\n');
  const eg = path.join('catalog', 'EntryGroups', 'commerce_eg');
  fs.mkdirSync(eg, {recursive: true});
  fs.writeFileSync(path.join(eg, 'commerce.yaml'), MODEL_YAML);
}

function printed(): any {
  return JSON.parse(out.join('\n'));
}

beforeEach(() => {
  cwd = process.cwd();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcmd-entry-'));
  process.chdir(dir);
  out = [];
  err = [];
  spyOn(console, 'log').mockImplementation((...args: any[]) => {
    out.push(args.join(' '));
  });
  spyOn(console, 'error').mockImplementation((...args: any[]) => {
    err.push(args.join(' '));
  });
  spyOn(console, 'warn').mockImplementation(() => {});
  spyOn(globalThis, 'fetch').mockImplementation((async () => {
    throw new Error('a test made a network call');
  }) as any);
  spyOn(cp, 'execSync').mockImplementation((() => {
    throw new Error('a test ran a gcloud command');
  }) as any);
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
  process.chdir(cwd);
  fs.rmSync(dir, {recursive: true, force: true});
  mock.restore();
});

describe('kcmd entry list', () => {
  test('prints each entry\'s name and type, sorted by name', async () => {
    writeStandardWorkspace();
    expect(await entry('list')).toBe(0);
    expect(printed()).toEqual([
      {name: 'orders', type: 'test-project.us.table'},
      {name: 'sub/refunds', type: 'dataplex-types.global.generic'},
    ]);
    expect(err).toEqual([]);
  });

  test('--content prints the full entries', async () => {
    writeStandardWorkspace();
    expect(await entry('list', [], {content: true})).toBe(0);
    expect(printed()).toEqual([ORDERS, REFUNDS]);
  });

  test('--type matches the last part of the type or the full reference',
       async () => {
         writeStandardWorkspace();
         expect(await entry('list', [], {type: 'generic'})).toBe(0);
         expect(printed().map((e: any) => e.name)).toEqual(['sub/refunds']);

         out = [];
         expect(await entry('list', [], {type: 'test-project.us.table'}))
             .toBe(0);
         expect(printed().map((e: any) => e.name)).toEqual(['orders']);

         out = [];
         expect(await entry('list', [], {type: 'table-x'})).toBe(0);
         expect(printed()).toEqual([]);
       });

  test('an empty workspace lists nothing', async () => {
    fs.writeFileSync('catalog.yaml', 'scope: entryGroup.test-project.us.eg\n');
    expect(await entry('list')).toBe(0);
    expect(printed()).toEqual([]);
  });
});

describe('kcmd entry get', () => {
  test('prints the named entries in the order given', async () => {
    writeStandardWorkspace();
    expect(await entry('get', ['sub/refunds', 'orders'])).toBe(0);
    expect(printed()).toEqual([REFUNDS, ORDERS]);
  });

  test('fails naming every entry it cannot read, and prints nothing',
       async () => {
         writeStandardWorkspace();
         expect(await entry('get', ['orders', 'nope', 'gone'])).toBe(1);
         expect(out).toEqual([]);
         const message = err.join('\n');
         expect(message).toContain('cannot read 2 of the entries');
         expect(message).toContain('nope: Entry not found: nope');
         expect(message).toContain('gone: Entry not found: gone');
       });
});

describe('kcmd entry usage', () => {
  const cases: [string, string, string[], object, string][] = [
    ['an unknown action', 'show', [], {}, 'unknown entry action \'show\''],
    ['get without names', 'get', [], {}, 'needs at least one entry name'],
    ['list with names', 'list', ['orders'], {}, 'takes no entry names'],
    ['--type on get', 'get', ['orders'], {type: 'x'}, 'apply only to entry list'],
    ['--content on get', 'get', ['orders'], {content: true},
     'apply only to entry list'],
  ];
  for (const [label, action, names, options, message] of cases) {
    test(`${label} fails before opening the workspace`, async () => {
      expect(await entry(action, names, options)).toBe(1);
      expect(out).toEqual([]);
      expect(err.join('\n')).toContain(message);
    });
  }

  test('a folder with no catalog.yaml fails', async () => {
    await expect(entry('list')).rejects.toThrow('Cannot find catalog manifest');
  });
});

describe('kcmd entry on a semantic-model workspace', () => {
  // The model file is shown as the entries push writes for it, with no
  // request and no gcloud command.
  test('lists the model\'s entries', async () => {
    writeSemanticWorkspace();
    expect(await entry('list')).toBe(0);
    expect(printed()).toEqual([
      {name: 'commerce', type: 'dataplex-types.global.semantic-model'},
      {
        name: 'commerce.entities.Customer',
        type: 'dataplex-types.global.semantic-entity',
      },
    ]);
  });

  test('get prints an entry of the model', async () => {
    writeSemanticWorkspace();
    expect(await entry('get', ['commerce.entities.Customer'])).toBe(0);
    const [customer] = printed();
    expect(customer.resource).toEqual({displayName: 'Customer', parent: 'commerce'});
    expect(customer.aspects['dataplex-types.global.schema'].primaryKey)
        .toEqual({fields: ['key']});
  });

  test('reports a SQL parser that cannot load', async () => {
    writeSemanticWorkspace();
    spyOn(sqlParser, 'loadSqlEngine').mockRejectedValue(new Error('simulated'));
    expect(await entry('list')).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual(['Error: the SQL parser could not be loaded: simulated']);
  });

  test('delete removes an element from the model file', async () => {
    writeSemanticWorkspace();
    expect(await entry('delete', ['commerce.entities.Customer'])).toBe(0);
    expect(printed()).toEqual([{name: 'commerce.entities.Customer', ok: true}]);
    const model = fs.readFileSync(
        path.join('catalog', 'EntryGroups', 'commerce_eg', 'commerce.yaml'), 'utf8');
    expect(model).not.toContain('Customer');
  });

  test('get of an element name, not an entry name, fails', async () => {
    writeSemanticWorkspace();
    expect(await entry('get', ['Customer'])).toBe(1);
    expect(out).toEqual([]);
    expect(err.join('\n')).toContain('Customer');
  });
});

describe('matchesType', () => {
  test('matches the full reference and its trailing parts only', () => {
    const type = 'dataplex-types.global.semantic-entity';
    expect(matchesType(type, type)).toBe(true);
    expect(matchesType(type, 'semantic-entity')).toBe(true);
    expect(matchesType(type, 'global.semantic-entity')).toBe(true);
    expect(matchesType(type, 'entity')).toBe(false);
    expect(matchesType(undefined, 'semantic-entity')).toBe(false);
  });
});

describe('kcmd entry, as a process', () => {
  // main.ts runs on import, so these spawn it. A semantic-model workspace
  // opens without a request, so the child needs neither network nor gcloud.
  function run(...args: string[]): {code: number; stdout: string; stderr: string} {
    const p = Bun.spawnSync({
      cmd: ['bun', MAIN, 'entry', ...args],
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      code: p.exitCode ?? -1,
      stdout: p.stdout.toString(),
      stderr: p.stderr.toString(),
    };
  }

  test('prints one JSON value on stdout and exits 0', () => {
    writeSemanticWorkspace();
    const {code, stdout} = run('list', '--type', 'semantic-model');
    expect(code).toBe(0);
    expect(JSON.parse(stdout))
        .toEqual([{name: 'commerce', type: 'dataplex-types.global.semantic-model'}]);
  }, 30000);

  test('exits 1 with nothing on stdout when an entry cannot be read', () => {
    writeSemanticWorkspace();
    const {code, stdout, stderr} = run('get', 'Customer');
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('cannot read 1 of the entries');
  }, 30000);
});

function writeItems(items: unknown, file = 'items.json'): string {
  fs.writeFileSync(file, JSON.stringify(items));
  return file;
}

function entryOnDisk(file: string): any {
  return yaml.parse(fs.readFileSync(path.join('catalog', file), 'utf8'));
}

describe('kcmd entry save', () => {
  test('saves one entry given as an object', async () => {
    writeStandardWorkspace();
    const created = {name: 'payments', type: 'test-project.us.table', resource: {}};
    expect(await entry('save', [writeItems(created)])).toBe(0);
    expect(printed()).toEqual([{name: 'payments', ok: true}]);
    expect(entryOnDisk('payments.yaml')).toEqual(created);
  });

  test('applies many items in order and reports each, in order', async () => {
    writeStandardWorkspace();
    const file = writeItems([
      {name: 'payments', type: 'test-project.us.table', resource: {}},
      {...ORDERS, resource: {...ORDERS.resource, description: 'Updated.'}},
      {name: 'bad', type: 'test-project.us.table', aspect: {}},
      {name: 'payments', type: 'test-project.us.table', resource: {}},
      {type: 'test-project.us.table'},
      {name: '../escape', type: 'test-project.us.table'},
    ]);

    expect(await entry('save', [file])).toBe(1);
    const results = printed();
    expect(results.map((r: any) => [r.name, r.ok])).toEqual([
      ['payments', true],
      ['orders', true],
      ['bad', false],
      ['payments', false],
      ['(item 5)', false],
      ['../escape', false],
    ]);
    expect(results[2].error).toContain('Unrecognized key');
    expect(results[2].error).toContain('aspect');
    expect(results[3].error).toContain('appears more than once');
    expect(results[4].error).toContain('name');
    expect(results[5].error).toContain('points outside the catalog folder');
    expect(entryOnDisk('orders.yaml').resource.description).toBe('Updated.');
    expect(fs.existsSync(path.join('catalog', 'bad.yaml'))).toBe(false);
  });

  test('what entry get prints saves back without writing anything',
       async () => {
         writeStandardWorkspace();
         expect(await entry('get', ['orders', 'sub/refunds'])).toBe(0);
         const file = writeItems(printed());
         const past = new Date('2020-01-01T00:00:00Z');
         for (const f of ['orders.yaml', path.join('sub', 'refunds.yaml')]) {
           fs.utimesSync(path.join('catalog', f), past, past);
         }

         out = [];
         expect(await entry('save', [file])).toBe(0);
         expect(printed().every((r: any) => r.ok)).toBe(true);
         for (const f of ['orders.yaml', path.join('sub', 'refunds.yaml')]) {
           expect(fs.statSync(path.join('catalog', f)).mtime.toISOString())
               .toBe(past.toISOString());
         }
       });

  test('input that is not JSON fails the call and writes nothing', async () => {
    writeStandardWorkspace();
    fs.writeFileSync('items.json', '{"name": ');
    expect(await entry('save', ['items.json'])).toBe(1);
    expect(out).toEqual([]);
    expect(err.join('\n')).toContain('\'items.json\' is not valid JSON');
  });

  test('a missing file fails the call', async () => {
    writeStandardWorkspace();
    expect(await entry('save', ['nope.json'])).toBe(1);
    expect(out).toEqual([]);
    expect(err.join('\n')).toContain('cannot read \'nope.json\'');
  });
});

describe('kcmd entry delete', () => {
  test('deletes each name and reports the ones it cannot', async () => {
    writeStandardWorkspace();
    expect(await entry('delete', ['orders', 'nope'])).toBe(1);
    expect(printed()).toEqual([
      {name: 'orders', ok: true},
      {name: 'nope', ok: false, error: 'Entry not found: nope'},
    ]);
    expect(fs.existsSync(path.join('catalog', 'orders.yaml'))).toBe(false);
  });

  test('exits 0 when every name is deleted', async () => {
    writeStandardWorkspace();
    expect(await entry('delete', ['sub/refunds'])).toBe(0);
    expect(printed()).toEqual([{name: 'sub/refunds', ok: true}]);
  });
});

describe('kcmd entry save and delete usage', () => {
  const cases: [string, string, string[], string][] = [
    ['save without a file', 'save', [], 'takes one file'],
    ['save with two files', 'save', ['a.json', 'b.json'], 'takes one file'],
    ['delete without names', 'delete', [], 'needs at least one entry name'],
  ];
  for (const [label, action, args, message] of cases) {
    test(`${label} fails before opening the workspace`, async () => {
      expect(await entry(action, args)).toBe(1);
      expect(out).toEqual([]);
      expect(err.join('\n')).toContain(message);
    });
  }
});

describe('kcmd entry save, as a process', () => {
  test('reads standard input and prints one result per item', () => {
    writeSemanticWorkspace();
    const p = Bun.spawnSync({
      cmd: ['bun', MAIN, 'entry', 'save', '-'],
      cwd: dir,
      stdin: Buffer.from(JSON.stringify(
          [{name: 'refunds', type: 'dataplex-types.global.semantic-entity'}])),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(p.exitCode).toBe(0);
    expect(JSON.parse(p.stdout.toString()))
        .toEqual([{name: 'commerce.entities.refunds', ok: true}]);
    const model = fs.readFileSync(
        path.join('catalog', 'EntryGroups', 'commerce_eg', 'commerce.yaml'), 'utf8');
    expect(model).toContain('- name: refunds');
  }, 30000);
});
