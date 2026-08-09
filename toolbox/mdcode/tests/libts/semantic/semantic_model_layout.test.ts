// Tests for the SemanticModel layout's pull write-path
// (src/libts/layouts/semantic-model.ts): modelPath / hasModel /
// writeModelDocument. These are the sink `pull` writes reconstructed models to;
// the push-side discovery (modelDocuments) is exercised via the deploy tests.

import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {SemanticModelLayout} from '../../../src/libts/layouts/semantic-model';

let root: string;
let catalogPath: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcmd-layout-'));
  catalogPath = path.join(root, 'catalog');
});

afterEach(() => {
  fs.rmSync(root, {recursive: true, force: true});
});

async function layout(entryGroup?: string): Promise<SemanticModelLayout> {
  const l = new SemanticModelLayout(catalogPath, entryGroup);
  await l.init();
  return l;
}


describe('SemanticModelLayout write path', () => {
  test('modelPath maps to EntryGroups/<entryGroup>/<name>.yaml', async () => {
    const l = await layout('eg');
    expect(l.modelPath('sales'))
        .toBe(path.join(catalogPath, 'EntryGroups', 'eg', 'sales.yaml'));
  });

  test('modelPath sanitizes path separators in the model name', async () => {
    const l = await layout('eg');
    expect(l.modelPath('a/b'))
        .toBe(path.join(catalogPath, 'EntryGroups', 'eg', 'a_b.yaml'));
  });

  test('modelPath throws without an entry group', async () => {
    const l = await layout(undefined);
    expect(() => l.modelPath('sales')).toThrow(/entry group/i);
  });

  test(
      'writeModelDocument creates the file, dirs, and indexes it', async () => {
        const l = await layout('eg');
        expect(l.hasModel('sales')).toBe(false);

        l.writeModelDocument('sales', 'version: x\n');

        const p = l.modelPath('sales');
        expect(fs.existsSync(p)).toBe(true);
        expect(fs.readFileSync(p, 'utf8')).toBe('version: x\n');
        expect(l.hasModel('sales')).toBe(true);
        // Indexed, so a subsequent read surfaces it as a model document.
        expect(l.modelDocuments()).toEqual([
          {name: 'sales', text: 'version: x\n'}
        ]);
      });

  test(
      'writeModelDocument overwrites an existing document (last-write-wins)',
      async () => {
        const l = await layout('eg');
        l.writeModelDocument('sales', 'first\n');
        l.writeModelDocument('sales', 'second\n');
        expect(fs.readFileSync(l.modelPath('sales'), 'utf8')).toBe('second\n');
      });
});
