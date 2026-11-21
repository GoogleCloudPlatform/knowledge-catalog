// Tests for the KC converter's read direction (modelsFromCatalogResources in
// src/libts/semantic/kc_converter.ts).
//
// The reader rebuilds each model from the second-generation types. A whole
// model's round trip through push and pull, and the warning about a model an
// older kcmd pushed, are covered in pull_kc.test.ts; action and constraint
// entries in actions.test.ts and constraints.test.ts. What pull cannot show,
// since it refuses an entry group holding more than one model, is how the
// reader groups the entries of several models.

import {describe, expect, test} from 'bun:test';

import {modelsFromCatalogResources} from '../../../src/libts/semantic/kc_converter';
import {generateCatalogResources} from '../../../src/libts/semantic/knowledge_catalog';

const OPTS = {
  project: 'dest',
  location: 'us',
  entryGroup: 'eg',
};

describe('anchor / parent grouping', () => {
  test('two models keep their own children by parentEntry', () => {
    const [a, b] = ['a', 'b'].map(
        name => generateCatalogResources(
            {
              name,
              version: '0.2.0.dev0/google',
              entities: [
                {name: `e${name}`, dataSource: `p.d.${name}`, keys: [], fields: []}
              ],
              relationships: [],
              metrics: [],
            },
            OPTS));
    // A model takes its display name as its name, or else the last segment of
    // its entry ID.
    a.entries[0].entrySource!.displayName = 'Model A';
    const [anchor, entity] = b.entries;
    anchor.name = entity.parentEntry = anchor.name.replace(/b$/, 'team/b');
    delete anchor.entrySource!.displayName;
    const {models} = modelsFromCatalogResources([...a.entries, ...b.entries]);
    const byName = new Map(models.map(m => [m.name, m]));
    expect(byName.get('Model A')!.entities.map(e => e.name)).toEqual(['ea']);
    expect(byName.get('b')!.entities.map(e => e.name)).toEqual(['eb']);
  });
});
