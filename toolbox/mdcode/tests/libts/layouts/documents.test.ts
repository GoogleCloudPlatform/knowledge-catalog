// Tests DocumentsLayout writes (src/libts/layouts/documents.ts): a name must
// stay inside the catalog folder, an unchanged entry keeps its file, and a
// write leaves no temporary file behind.

import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {DocumentsLayout} from '../../../src/libts/layouts/documents';

let dir = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcmd-documents-'));
});

afterEach(() => {
  fs.rmSync(dir, {recursive: true, force: true});
});

const PAGE = {
  name: 'guides/refunds',
  type: 'dataplex-types.global.generic',
  resource: {description: 'How refunds work.'},
  aspects: {'dataplex-types.global.overview': {content: '# Refunds\n'}},
};

describe('DocumentsLayout.saveEntry', () => {
  test('refuses a name that would write outside the catalog folder',
       async () => {
         const catalog = path.join(dir, 'catalog');
         fs.mkdirSync(catalog);
         const layout = new DocumentsLayout(catalog);
         await layout.init();

         await expect(layout.saveEntry('../escape', {...PAGE, name: '../escape'}))
             .rejects.toThrow('points outside the catalog folder');
         expect(fs.readdirSync(dir)).toEqual(['catalog']);
       });

  // A load adds values the file does not hold (a derived parent, the generic
  // aspect), so this saves the same entry twice rather than what load gives.
  test('writes a page once and leaves it untouched when saved unchanged',
       async () => {
         const layout = new DocumentsLayout(dir);
         await layout.init();
         await layout.saveEntry(PAGE.name, PAGE);

         const file = path.join(dir, 'guides', 'refunds.md');
         const past = new Date('2020-01-01T00:00:00Z');
         fs.utimesSync(file, past, past);
         await layout.saveEntry(PAGE.name, PAGE);

         expect(fs.statSync(file).mtime.toISOString()).toBe(past.toISOString());
         expect(fs.readdirSync(path.join(dir, 'guides'))).toEqual(['refunds.md']);
       });
});
