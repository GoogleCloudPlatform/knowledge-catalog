// Tests for relationship entries (src/libts/semantic/kc_relationships.ts):
// the `semantic-relationship` entry of mapping Addendum 6 for a relationship,
// and the relationship read back from such an entry.

import {describe, expect, test} from 'bun:test';

import {Relationship, SemanticModel} from '../../../src/libts/semantic/ir';
import {Namer} from '../../../src/libts/semantic/kc_ids';
import {readRelationshipEntry, relationshipEntry} from '../../../src/libts/semantic/kc_relationships';

const BOUND: Relationship = {
  name: 'refund_of_order',
  source: {entity: 'refunds', columns: ['tenant', 'order_id']},
  destination: {entity: 'orders', columns: ['tenant', 'id']},
  description: 'Each refund belongs to one order.',
  aiContext: {instructions: 'Join refunds to orders.', synonyms: ['refunded_order']},
};

const UNBOUND: Relationship = {
  name: 'placed_by',
  source: {entity: 'orders', columns: []},
  destination: {entity: 'customers', columns: []},
};

function model(overrides: Partial<SemanticModel> = {}): SemanticModel {
  return {
    name: 'sales',
    entities: [],
    metrics: [],
    relationships: [BOUND, UNBOUND],
    ...overrides,
  };
}

function namer(v2Aspects = false): Namer {
  return new Namer({project: 'p', location: 'us', entryGroup: 'eg', v2Aspects});
}

describe('relationshipEntry', () => {
  test('writes a bound relationship as Addendum 6 shapes it', () => {
    const entry = relationshipEntry(model(), BOUND, namer());
    expect(entry).toEqual({
      name: 'projects/p/locations/us/entryGroups/eg/entries/' +
          'sales.relationships.refund_of_order',
      entryType: 'projects/dataplex-types/locations/global/entryTypes/' +
          'semantic-relationship',
      parentEntry: 'projects/p/locations/us/entryGroups/eg/entries/sales',
      entrySource: {
        displayName: 'refund_of_order',
        description: 'Each refund belongs to one order.',
      },
      aspects: {
        'dataplex-types.global.semantic-relationship': {
          aspectType: 'projects/dataplex-types/locations/global/aspectTypes/' +
              'semantic-relationship',
          data: {
            source: {name: 'refunds', fields: ['tenant', 'order_id']},
            target: {name: 'orders', fields: ['tenant', 'id']},
            synonyms: ['refunded_order'],
          },
        },
        'dataplex-types.global.guidelines': {
          aspectType:
              'projects/dataplex-types/locations/global/aspectTypes/guidelines',
          data: {instructions: 'Join refunds to orders.', userManaged: true},
        },
      },
    } as any);
  });

  test('leaves out fields for an unbound relationship', () => {
    const entry = relationshipEntry(model(), UNBOUND, namer());
    expect(entry.aspects!['dataplex-types.global.semantic-relationship'].data)
        .toEqual({source: {name: 'orders'}, target: {name: 'customers'}});
    expect(entry.aspects!['dataplex-types.global.guidelines']).toBeUndefined();
    expect(entry.entrySource).toEqual({displayName: 'placed_by'});
  });

  test('names the entry <model>/relationships/<name> with V2 ids', () => {
    expect(relationshipEntry(model(), BOUND, namer(true)).name)
        .toBe('projects/p/locations/us/entryGroups/eg/entries/' +
              'sales/relationships/refund_of_order');
  });

  test('lists the join columns of each named profile that binds it', () => {
    const withProfiles = model({
      profiles: [
        {
          name: 'analytical',
          entities: [],
          relationships: [
            {name: 'refund_of_order', fromColumns: ['t'], toColumns: ['t2']},
          ],
        },
        {name: 'other', entities: [], relationships: []},
      ],
    });
    const data = relationshipEntry(withProfiles, BOUND, namer())
                     .aspects!['dataplex-types.global.semantic-relationship']
                     .data;
    expect(data?.profiles).toEqual(
        [{name: 'analytical', sourceFields: ['t'], targetFields: ['t2']}]);
  });
});

describe('readRelationshipEntry', () => {
  test('reads back what relationshipEntry wrote', () => {
    for (const rel of [BOUND, UNBOUND]) {
      const problems: string[] = [];
      expect(readRelationshipEntry(
                 relationshipEntry(model(), rel, namer()), problems))
          .toEqual(rel);
      expect(problems).toEqual([]);
    }
  });

  test('reports what it cannot read', () => {
    const cases: [any, string][] = [
      [{}, 'resource.displayName must hold its name'],
      [{data: {target: {name: 'orders'}}}, 'source.name must name an entity'],
      [{data: {source: {name: 'a', fields: [1]}, target: {name: 'b'}}},
       'source.fields must be a list of column names'],
      [{data: {source: {name: 'a'}, target: {name: 'b'}, synonyms: 'x'}},
       'synonyms must be a list of strings'],
    ];
    for (const [shape, message] of cases) {
      const problems: string[] = [];
      readRelationshipEntry(
          {
            name: 'x',
            entryType: 'semantic-relationship',
            entrySource: shape.data ? {displayName: 'r'} : {},
            aspects: shape.data ? {
              'dataplex-types.global.semantic-relationship':
                  {aspectType: 'semantic-relationship', data: shape.data},
            } :
                                  {},
          } as any,
          problems);
      expect(problems.join('\n')).toContain(message);
    }
  });
});
