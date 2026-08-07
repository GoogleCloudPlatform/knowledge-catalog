// Tests --target resolution for the semantic-model push (src/tool/commands.ts).
//
// The two deploy legs are covered end to end elsewhere (deploy.test.ts for
// BigQuery, kc.test.ts for Knowledge Catalog); this pins only the flag-to-
// destinations mapping and its ordering, which drives the dispatch in push().

import {describe, expect, test} from 'bun:test';

import {resolveTargets} from '../../../src/tool/commands';

describe('resolveTargets', () => {
  test('defaults to BigQuery when no target is given', () => {
    expect(resolveTargets(undefined)).toEqual(['bigquery']);
  });
  test('\'bq\' and \'bigquery\' both select BigQuery', () => {
    expect(resolveTargets('bq')).toEqual(['bigquery']);
    expect(resolveTargets('bigquery')).toEqual(['bigquery']);
  });
  test('\'kc\' selects Knowledge Catalog', () => {
    expect(resolveTargets('kc')).toEqual(['kc']);
  });
  test('\'both\' runs BigQuery first (fail-fast ordering)', () => {
    expect(resolveTargets('both')).toEqual(['bigquery', 'kc']);
  });
  test('is case-insensitive', () => {
    expect(resolveTargets('BOTH')).toEqual(['bigquery', 'kc']);
  });
  test('an unknown target resolves to undefined', () => {
    expect(resolveTargets('dataplex')).toBeUndefined();
  });
});
