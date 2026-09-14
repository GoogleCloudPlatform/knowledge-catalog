// Tests for the shared document loader (loadSemanticModels in
// src/libts/semantic/loader.ts).
//
// loadSemanticModels parses every authored document into the IR ONCE so a
// multi-destination push (BigQuery + Knowledge Catalog) validates each model a
// single time and fans the result out to both legs. It tags each model with its
// document, prefixes loader warnings with the document name, and returns a
// parse/schema error (naming the document) rather than throwing.

import {describe, expect, test} from 'bun:test';

import {loadSemanticModels} from '../../../src/libts/semantic/loader';

// A minimal loader-valid document: one model, one dataset (with a primary key
// so it does not warn), no metrics.
function doc(modelName: string, source = 'proj.ds.tbl'): string {
  return `version: 0.2.0.dev0
semantic_model:
  - name: ${modelName}
    datasets:
      - name: orders
        source: ${source}
        primary_key: [id]
        fields:
          - name: id
            expression:
              dialects:
                - dialect: BIGQUERY
                  expression: id
`;
}

describe('loadSemanticModels', () => {
  test(
      'flattens models across documents, tagging each with its document',
      () => {
        const res = loadSemanticModels([
          {name: 'a.yaml', text: doc('sales')},
          {name: 'b.yaml', text: doc('ops')},
        ]);
        expect(res.error).toBeUndefined();
        expect(res.models.map(m => m.document)).toEqual(['a.yaml', 'b.yaml']);
        expect(res.models.map(m => m.model.name)).toEqual(['sales', 'ops']);
      });

  test('prefixes loader warnings with the originating document name', () => {
    // A dataset with no primary_key makes the loader warn; the warning must
    // carry the document name so a multi-document push stays diagnosable.
    const noKey = `version: 0.2.0.dev0
semantic_model:
  - name: sales
    datasets:
      - name: orders
        source: proj.ds.tbl
`;
    const res = loadSemanticModels([{name: 'sales.yaml', text: noKey}]);
    expect(res.error).toBeUndefined();
    expect(res.warnings.some(w => w.startsWith('[sales.yaml] '))).toBe(true);
  });

  test('returns a document-named error on a parse/schema failure', () => {
    // The second document is not a valid model; the error must name it and the
    // models parsed before it are still returned.
    const res = loadSemanticModels([
      {name: 'good.yaml', text: doc('sales')},
      {name: 'broken.yaml', text: 'semantic_model: [ this is: not valid'},
    ]);
    expect(res.error).toBeDefined();
    expect(res.error).toContain('broken.yaml');
    expect(res.models.map(m => m.model.name)).toEqual(['sales']);
  });

  test('applies defaultProject when a source omits its project', () => {
    const res = loadSemanticModels(
        [{name: 'sales.yaml', text: doc('sales', 'ds.tbl')}],
        {defaultProject: 'scope-proj'});
    expect(res.error).toBeUndefined();
    expect(res.models[0].model.entities[0].dataSource)
        .toBe('scope-proj.ds.tbl');
  });

  test('no documents yields no models and no error', () => {
    const res = loadSemanticModels([]);
    expect(res.error).toBeUndefined();
    expect(res.models).toEqual([]);
    expect(res.warnings).toEqual([]);
  });
});
