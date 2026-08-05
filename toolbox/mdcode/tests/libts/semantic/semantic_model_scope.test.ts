// Tests the semantic-model scope + SemanticModel layout wiring: the scope
// string round-trips through the manifest, and a snapshot over an authored
// workspace resolves to the SemanticModel layout and reads the Ossie model
// document (while ignoring sidecar files).

import {afterEach, describe, expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {ApiContext} from '../../../src/libts/gcp/context';
import {Layouts} from '../../../src/libts/layout';
import {SemanticModelLayout} from '../../../src/libts/layouts/semantic-model';
import {CatalogManifest} from '../../../src/libts/manifest';
import {CatalogSnapshot} from '../../../src/libts/snapshot';
import {SemanticModelSource} from '../../../src/libts/sources/semantic-model';

const CTX = new ApiContext('test-project', 'us', 'test-token');


describe('SemanticModelSource', () => {
  test('parses a well-formed scope name', () => {
    const s = new SemanticModelSource('semantic-model', 'proj.us.eg');
    expect(s.type).toBe('semantic-model');
    expect(s.project).toBe('proj');
    expect(s.location).toBe('us');
    expect(s.entryGroup).toBe('eg');
    expect(s.layout).toBe(Layouts.SEMANTIC_MODEL);
    expect(s.ingestedEntries).toBe(false);
  });

  test('rejects a malformed scope name', () => {
    expect(() => new SemanticModelSource('semantic-model', 'proj.us'))
        .toThrow();
  });
});


describe('semantic-model scope wiring', () => {
  let dir = '';

  afterEach(() => {
    if (dir) {
      fs.rmSync(dir, {recursive: true, force: true});
      dir = '';
    }
  });

  test(
      'manifest writes the scope; snapshot resolves the layout and reads the model',
      async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcmd-sm-'));

        // init: manifest carries the semantic-model scope string.
        const manifest = await CatalogManifest.initWithSemanticModel(
            'proj.us.sales-group', CTX);
        manifest.save(path.join(dir, 'catalog.yaml'));
        expect(fs.readFileSync(path.join(dir, 'catalog.yaml'), 'utf8'))
            .toContain('scope: semantic-model.proj.us.sales-group');

        // author: a single Ossie model document, plus a sidecar that must be
        // ignored.
        const modelDir =
            path.join(dir, 'catalog', 'EntryGroups', 'sales-group');
        fs.mkdirSync(modelDir, {recursive: true});
        fs.writeFileSync(
            path.join(modelDir, 'sales.yaml'),
            'semantic_model:\n  - name: sales\n');
        fs.writeFileSync(
            path.join(modelDir, 'sales.aspects.yaml'), 'name: sales\n');

        // A second, unrelated EntryGroup directory (with a colliding basename)
        // that the scoped layout must NOT pick up.
        const otherDir =
            path.join(dir, 'catalog', 'EntryGroups', 'other-group');
        fs.mkdirSync(otherDir, {recursive: true});
        fs.writeFileSync(
            path.join(otherDir, 'sales.yaml'),
            'semantic_model:\n  - name: other\n');

        // load: scope -> source -> layout resolves to the SemanticModel layout.
        const snapshot = await CatalogSnapshot.fromPath(dir, CTX);
        expect(snapshot.manifest.source.type).toBe('semantic-model');
        expect(snapshot.layout).toBeInstanceOf(SemanticModelLayout);

        const layout = snapshot.layout as SemanticModelLayout;
        // Push-only layout: it exposes no per-entry Knowledge Catalog files.
        expect(layout.listEntries()).toEqual([]);

        // Only the document under the scoped EntryGroup is discovered; the
        // colliding sales.yaml in other-group is ignored.
        const docs = layout.modelDocuments();
        expect(docs).toHaveLength(1);
        expect(docs[0].name).toBe('sales');
        expect(docs[0].text).toContain('name: sales');
      });
});
