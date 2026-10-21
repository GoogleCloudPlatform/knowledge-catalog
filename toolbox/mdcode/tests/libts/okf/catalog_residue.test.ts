import {describe, expect, test} from 'bun:test';

import {Entry} from '../../../src/libts/gcp/dataplex';
import {assertResidueOnly, buildResidue, ResidueError, RESIDUE_VERSION, typeFacetKey} from '../../../src/libts/okf/catalog_residue';
import {RESIDUE_KEY} from '../../../src/libts/okf/concept';

const OVERVIEW = 'dataplex-types.global.overview';

function entry(over: Partial<Entry> = {}): Entry {
  return {
    name: 'projects/p/locations/us/entryGroups/kb/entries/a',
    entryType: 'projects/dataplex-types/locations/global/entryTypes/generic',
    ...over,
  } as Entry;
}

describe('buildResidue', () => {
  test('carries the entry type and parent', () => {
    const r = buildResidue(entry({parentEntry: 'x/y'}), OVERVIEW)!;
    expect(r['v']).toBe(RESIDUE_VERSION);
    expect(r['entryType']).toContain('entryTypes/generic');
    expect(r['parentEntry']).toBe('x/y');
  });

  test('carries every aspect except the overview', () => {
    const r = buildResidue(
      entry({
        aspects: {
          [OVERVIEW]: {data: {content: 'body'}},
          'dataplex-types.global.schema': {data: {fields: [{name: 'c'}]}},
        },
      } as Partial<Entry>),
      OVERVIEW,
    )!;
    const aspects = r['aspects'] as Record<string, unknown>;
    expect(Object.keys(aspects)).toEqual(['dataplex-types.global.schema']);
  });

  test('carries entrySource fields with no OKF home', () => {
    const r = buildResidue(
      entry({entrySource: {system: 'BIGQUERY', platform: 'GCP'}}),
      OVERVIEW,
    )!;
    expect(r['entrySource']).toEqual({system: 'BIGQUERY', platform: 'GCP'});
  });

  test('omits displayName, description and resource', () => {
    const r = buildResidue(
      entry({
        entrySource: {displayName: 'a', description: 'b', resource: 'bq://c'},
      }),
      OVERVIEW,
    )!;
    expect(r['entrySource']).toBeUndefined();
  });

  test('omits server-set timestamps', () => {
    const r = buildResidue(
      entry({
        createTime: '2026-01-01T00:00:00Z',
        entrySource: {createTime: '2026-01-01T00:00:00Z', system: 'X'},
      }),
      OVERVIEW,
    )!;
    expect(JSON.stringify(r)).not.toContain('2026-01-01');
  });

  test('an entry with nothing to carry yields no block', () => {
    const bare = {name: 'n', entryType: ''} as Entry;
    expect(buildResidue(bare, OVERVIEW)).toBeUndefined();
  });

  test('omits the facet type that became the concept type', () => {
    const r = buildResidue(
      entry({
        entryType: 'projects/dataplex-types/locations/global/entryTypes/document',
        aspects: {
          'dataplex-types.global.document': {
            data: {type: 'knowledge-base', job: {name: 'enrich-1'}},
          },
        },
      } as Partial<Entry>),
      OVERVIEW,
    )!;
    const facet = (r['aspects'] as Record<string, any>)[
      'dataplex-types.global.document'
    ];
    expect(facet).toEqual({job: {name: 'enrich-1'}});
  });

  test('keeps the facet present when type was its only field', () => {
    const r = buildResidue(
      entry({
        entryType: 'projects/dataplex-types/locations/global/entryTypes/document',
        aspects: {
          'dataplex-types.global.document': {data: {type: 'table-context'}},
        },
      } as Partial<Entry>),
      OVERVIEW,
    )!;
    const aspects = r['aspects'] as Record<string, unknown>;
    expect(Object.keys(aspects)).toEqual(['dataplex-types.global.document']);
    expect(aspects['dataplex-types.global.document']).toEqual({});
  });

  test('keeps a type field on an aspect that is not the facet', () => {
    const r = buildResidue(
      entry({
        entryType: 'projects/dataplex-types/locations/global/entryTypes/document',
        aspects: {
          'dataplex-types.global.schema': {data: {type: 'RECORD'}},
        },
      } as Partial<Entry>),
      OVERVIEW,
    )!;
    const aspects = r['aspects'] as Record<string, any>;
    expect(aspects['dataplex-types.global.schema']).toEqual({type: 'RECORD'});
  });
});

describe('typeFacetKey', () => {
  test('derives the facet from the entry type', () => {
    expect(
      typeFacetKey('projects/dataplex-types/locations/global/entryTypes/document'),
    ).toBe('dataplex-types.global.document');
  });

  test('is undefined without an entry type', () => {
    expect(typeFacetKey(undefined)).toBeUndefined();
    expect(typeFacetKey('')).toBeUndefined();
  });
});

describe('assertResidueOnly', () => {
  test('accepts API-shaped residue', () => {
    expect(() =>
      assertResidueOnly({
        title: 'a',
        [RESIDUE_KEY]: {v: 1, entryType: 't', entrySource: {system: 'X'}},
      }),
    ).not.toThrow();
  });

  test('rejects a native key duplicated by name', () => {
    expect(() => assertResidueOnly({[RESIDUE_KEY]: {v: 1, title: 'a'}})).toThrow(
      /title/,
    );
  });

  test('rejects displayName nested under entrySource', () => {
    expect(() =>
      assertResidueOnly({[RESIDUE_KEY]: {v: 1, entrySource: {displayName: 'a'}}}),
    ).toThrow(/entrySource.displayName/);
  });

  test('no residue is fine', () => {
    expect(() => assertResidueOnly({type: 'Metric'})).not.toThrow();
  });

  test('a non-mapping residue throws', () => {
    expect(() => assertResidueOnly({[RESIDUE_KEY]: 'nope'})).toThrow(ResidueError);
  });

  test('rejects the facet type duplicated inside aspects', () => {
    expect(() =>
      assertResidueOnly({
        type: 'knowledge-base',
        [RESIDUE_KEY]: {
          v: 1,
          entryType:
            'projects/dataplex-types/locations/global/entryTypes/document',
          aspects: {'dataplex-types.global.document': {type: 'knowledge-base'}},
        },
      }),
    ).toThrow(/aspects\.dataplex-types\.global\.document\.type/);
  });

  test('accepts a type field on an aspect that is not the facet', () => {
    expect(() =>
      assertResidueOnly({
        type: 'knowledge-base',
        [RESIDUE_KEY]: {
          v: 1,
          entryType:
            'projects/dataplex-types/locations/global/entryTypes/document',
          aspects: {'dataplex-types.global.schema': {type: 'RECORD'}},
        },
      }),
    ).not.toThrow();
  });
});
