// Tests for the semantic entry type list (src/libts/semantic/entry_types.ts).
//
// The list is written out by hand so that the layouts and the OKF converters
// can read it without pulling in the emitter. These tests are what stop that
// copy from drifting: each type ID that another module owns a constant for is
// checked against the list, and the four that have no constant are checked
// through the predicates in kc_entries.

import {describe, expect, test} from 'bun:test';

import {Entry} from '../../../src/libts/gcp/dataplex';
import {
  entryTypeIdOf,
  isKnownSemanticEntryType,
  isSemanticEntryType,
  SEMANTIC_ENTRY_TYPE_IDS,
} from '../../../src/libts/semantic/entry_types';
import {isEntityEntry, isExploreEntry, isMetricEntry} from '../../../src/libts/semantic/kc_entries';
import {ACTION_TYPE_ID, CONSTRAINT_TYPE_ID, FILE_COPY_TYPE_ID} from '../../../src/libts/semantic/kc_custom_types';
import {RELATIONSHIP_TYPE} from '../../../src/libts/semantic/kc_relationships';

const FULL = (id: string) => `projects/p/locations/global/entryTypes/${id}`;
const REF = (id: string) => `dataplex-types.global.${id}`;

function entryOfType(id: string): Entry {
  return {name: 'projects/p/locations/global/entryGroups/g/entries/x', entryType: FULL(id)} as Entry;
}

describe('entryTypeIdOf', () => {
  test('reads the bare ID out of all three reference forms', () => {
    for (const id of SEMANTIC_ENTRY_TYPE_IDS) {
      expect(entryTypeIdOf(id)).toBe(id);
      expect(entryTypeIdOf(REF(id))).toBe(id);
      expect(entryTypeIdOf(FULL(id))).toBe(id);
    }
  });

  // The hyphens in `semantic-model-file` are the reason the ID is taken as the
  // last dot-segment rather than everything after the second dot.
  test('keeps a hyphenated ID whole', () => {
    expect(entryTypeIdOf(REF('semantic-model-file'))).toBe('semantic-model-file');
    expect(entryTypeIdOf(FULL('semantic-model-file'))).toBe('semantic-model-file');
  });

  test('tolerates an empty reference', () => {
    expect(entryTypeIdOf('')).toBe('');
  });
});

describe('the list does not drift', () => {
  // Each of these is the single definition of its type ID elsewhere in the
  // tree. If one is renamed, this fails rather than the split silently
  // routing that type into the OKF bundle.
  test.each([
    ['ACTION_TYPE_ID', ACTION_TYPE_ID],
    ['CONSTRAINT_TYPE_ID', CONSTRAINT_TYPE_ID],
    ['FILE_COPY_TYPE_ID', FILE_COPY_TYPE_ID],
    ['RELATIONSHIP_TYPE', RELATIONSHIP_TYPE],
  ])('%s is listed', (_name, id) => {
    expect(SEMANTIC_ENTRY_TYPE_IDS).toContain(id);
  });

  // These four have no exported constant, so they are pinned behaviourally
  // against the predicates that do know them.
  test('the types kc_entries recognizes are listed', () => {
    expect(isEntityEntry(entryOfType('semantic-entity'))).toBe(true);
    expect(isMetricEntry(entryOfType('semantic-metric'))).toBe(true);
    expect(isExploreEntry(entryOfType('semantic-explore'))).toBe(true);
    for (const id of ['semantic-entity', 'semantic-metric', 'semantic-explore', 'semantic-model']) {
      expect(SEMANTIC_ENTRY_TYPE_IDS).toContain(id);
    }
  });

  test('holds eight types and no duplicates', () => {
    expect(SEMANTIC_ENTRY_TYPE_IDS.length).toBe(8);
    expect(new Set(SEMANTIC_ENTRY_TYPE_IDS).size).toBe(8);
  });
});

describe('isSemanticEntryType', () => {
  test('claims every listed type, in every reference form', () => {
    for (const id of SEMANTIC_ENTRY_TYPE_IDS) {
      expect(isSemanticEntryType(id)).toBe(true);
      expect(isSemanticEntryType(REF(id))).toBe(true);
      expect(isSemanticEntryType(FULL(id))).toBe(true);
    }
  });

  // The asymmetry that makes this a prefix test: an unknown semantic type sent
  // to the model fails loudly, sent to the bundle it duplicates an entry.
  test('claims an unknown semantic type', () => {
    expect(isSemanticEntryType(REF('semantic-something-new'))).toBe(true);
    expect(isKnownSemanticEntryType(REF('semantic-something-new'))).toBe(false);
  });

  test('leaves the context set\'s own types alone', () => {
    for (const id of ['document', 'generic', 'entrygroup', 'glossary-term', 'bigquery-table']) {
      expect(isSemanticEntryType(REF(id))).toBe(false);
      expect(isSemanticEntryType(FULL(id))).toBe(false);
    }
  });

  // `semantics` is a field name inside the schema aspect, not an entry type;
  // the prefix test must not be fooled by a type that merely starts with the
  // same letters but is not hyphenated.
  test('does not claim a type that only shares the prefix letters', () => {
    expect(isSemanticEntryType(REF('semantics'))).toBe(false);
    expect(isSemanticEntryType(REF('semantic'))).toBe(false);
  });
});
