// Tests StandardLayout indexing (src/libts/layouts/standard.ts).
//
// Runs against a real temp directory (StandardLayout talks to node:fs and glob
// directly, so a temp dir is simpler than mocking the module). Focuses on how
// init() handles a catalog file it cannot parse: it must warn rather than drop
// the file silently, since push otherwise makes the destination match the
// directory and a vanished file is easy to miss.

import {afterEach, beforeEach, describe, expect, spyOn, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {StandardLayout} from '../../../src/libts/layouts/standard';

let dir = '';
let warn: ReturnType<typeof spyOn>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcmd-standard-'));
  warn = spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  fs.rmSync(dir, {recursive: true, force: true});
});

describe('StandardLayout.init', () => {
  test('indexes well-formed entries by their name', async () => {
    fs.writeFileSync(path.join(dir, 'good.yaml'), 'name: good\ntype: p.g.t\n');

    const layout = new StandardLayout(dir);
    await layout.init();

    expect(layout.listEntries()).toEqual(['good']);
    expect(warn).not.toHaveBeenCalled();
  });

  test(
      'warns about a malformed file instead of dropping it silently',
      async () => {
        fs.writeFileSync(
            path.join(dir, 'good.yaml'), 'name: good\ntype: p.g.t\n');
        // Unclosed flow mapping -> yaml.parse throws.
        fs.writeFileSync(path.join(dir, 'broken.yaml'), 'name: {broken\n');

        const layout = new StandardLayout(dir);
        await layout.init();

        // The valid file is still indexed; the broken one is not.
        expect(layout.listEntries()).toEqual(['good']);
        expect(warn).toHaveBeenCalledTimes(1);
        const message = String(warn.mock.calls[0][0]);
        expect(message).toContain('broken.yaml');
      });
});

describe('StandardLayout.saveEntry', () => {
  const ENTRY = {name: 'x', type: 'p.g.t', resource: {description: 'X.'}};

  function filesUnder(root: string): string[] {
    return fs.readdirSync(root, {recursive: true, withFileTypes: true})
        .filter(d => d.isFile())
        .map(d => path.relative(root, path.join(d.parentPath, d.name)))
        .sort();
  }

  test('writes a new entry to <name>.yaml, creating folders', async () => {
    const layout = new StandardLayout(dir);
    await layout.init();
    await layout.saveEntry('p.d/t', {...ENTRY, name: 'p.d/t'});

    expect(filesUnder(dir)).toEqual([path.join('p.d', 't.yaml')]);
    expect((await layout.loadEntry('p.d/t')).resource?.description).toBe('X.');
  });

  test('refuses a name that would write outside the catalog folder',
       async () => {
         const catalog = path.join(dir, 'catalog');
         fs.mkdirSync(catalog);
         const layout = new StandardLayout(catalog);
         await layout.init();

         for (const name of ['../escape', 'a/../../escape', '/tmp/escape']) {
           await expect(layout.saveEntry(name, {...ENTRY, name}))
               .rejects.toThrow('points outside the catalog folder');
         }
         expect(filesUnder(dir)).toEqual([]);
       });

  test('updates an entry in the file it was found in', async () => {
    fs.mkdirSync(path.join(dir, 'deep', 'er'), {recursive: true});
    fs.writeFileSync(
        path.join(dir, 'deep', 'er', 'moved.yaml'), 'name: x\ntype: p.g.t\n');
    const layout = new StandardLayout(dir);
    await layout.init();

    await layout.saveEntry('x', ENTRY);

    expect(filesUnder(dir)).toEqual([path.join('deep', 'er', 'moved.yaml')]);
    expect((await layout.loadEntry('x')).resource?.description).toBe('X.');
  });

  test('leaves the file of an unchanged entry untouched', async () => {
    const file = path.join(dir, 'x.yaml');
    const text = '# kept comment\nname: x\ntype: p.g.t\nresource:\n' +
        '  description: X.\n';
    fs.writeFileSync(file, text);
    const past = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(file, past, past);
    const layout = new StandardLayout(dir);
    await layout.init();

    const read = await layout.loadEntry('x');
    await layout.saveEntry('x', {...read, aspects: undefined} as any);

    expect(fs.readFileSync(file, 'utf8')).toBe(text);
    expect(fs.statSync(file).mtime.toISOString()).toBe(past.toISOString());
  });

  test('replaces a changed file without leaving a temporary file', async () => {
    fs.writeFileSync(path.join(dir, 'x.yaml'), 'name: x\ntype: p.g.t\n');
    const layout = new StandardLayout(dir);
    await layout.init();

    await layout.saveEntry('x', ENTRY);

    expect(filesUnder(dir)).toEqual(['x.yaml']);
    expect(fs.readFileSync(path.join(dir, 'x.yaml'), 'utf8'))
        .toContain('description: X.');
  });
});
