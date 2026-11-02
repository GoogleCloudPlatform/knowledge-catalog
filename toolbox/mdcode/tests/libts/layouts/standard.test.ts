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
