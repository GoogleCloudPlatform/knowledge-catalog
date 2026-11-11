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

import {modelsFromCatalogResources, splitDefinitionTrailer, splitEntityTrailers, splitInverse, splitSpecializes} from '../../../src/libts/semantic/kc_converter';
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
    const {models} = modelsFromCatalogResources([...a.entries, ...b.entries]);
    const byName = new Map(models.map(m => [m.name, m]));
    expect(byName.get('a')!.entities.map(e => e.name)).toEqual(['ea']);
    expect(byName.get('b')!.entities.map(e => e.name)).toEqual(['eb']);
  });
});

describe('trailer peeling helpers', () => {
  test('splitSpecializes and splitInverse recover metadata and strip trailer', () => {
    expect(splitSpecializes('Customer entity.\n\nSpecializes: Party, Account.'))
        .toEqual({description: 'Customer entity.', parents: ['Party', 'Account']});
    expect(splitInverse('Placed by customer.\n\nInverse: orders.'))
        .toEqual({description: 'Placed by customer.', inverse: 'orders'});
  });

  test('splitDefinitionTrailer and splitEntityTrailers strip trailers cleanly', () => {
    expect(splitDefinitionTrailer('High value.\n\nDefined as: total > 1000'))
        .toEqual({rest: 'High value.', definition: {expression: 'total > 1000'}});

    const full = [
      'People who buy.',
      'Specializes: Party.',
      'Abstract: no table of its own.',
    ].join('\n\n');
    expect(splitEntityTrailers(full)).toEqual({
      description: 'People who buy.',
      parents: ['Party'],
      abstract: true,
    });
  });
});
