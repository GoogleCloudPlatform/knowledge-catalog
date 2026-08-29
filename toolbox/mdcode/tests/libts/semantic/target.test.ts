// Tests --target resolution for the semantic-model push (src/tool/commands.ts).
//
// The two deploy legs are covered end to end elsewhere
// (deploy_bigquery.test.ts for BigQuery, deploy_knowledge_catalog.test.ts for
// Knowledge Catalog); this pins only the flag-to-destinations mapping and its
// ordering, which drives the dispatch in push().

import {describe, expect, test} from 'bun:test';

import {resolveTargets} from '../../../src/tool/commands';

describe('resolveTargets', () => {
  test('defaults to every destination when no target is given', () => {
    expect(resolveTargets(undefined)).toEqual(['bigquery', 'spanner', 'kc']);
  });
  test('\'bq\' and \'bigquery\' both select BigQuery', () => {
    expect(resolveTargets('bq')).toEqual(['bigquery']);
    expect(resolveTargets('bigquery')).toEqual(['bigquery']);
  });
  test('\'sp\' and \'spanner\' both select Spanner', () => {
    expect(resolveTargets('sp')).toEqual(['spanner']);
    expect(resolveTargets('spanner')).toEqual(['spanner']);
  });
  test('\'kc\' selects Knowledge Catalog', () => {
    expect(resolveTargets('kc')).toEqual(['kc']);
  });
  test('a comma-separated list selects each destination', () => {
    expect(resolveTargets('bq,kc')).toEqual(['bigquery', 'kc']);
    expect(resolveTargets('bq,spanner')).toEqual(['bigquery', 'spanner']);
  });
  test('\'all\' selects every destination', () => {
    expect(resolveTargets('all')).toEqual(['bigquery', 'spanner', 'kc']);
  });
  test('the result is always in canonical order (BigQuery first)', () => {
    // Regardless of how the user orders the flag, fail-fast runs BigQuery
    // first, then Spanner, then Knowledge Catalog.
    expect(resolveTargets('kc,bq')).toEqual(['bigquery', 'kc']);
    expect(resolveTargets('kc,spanner,bq')).toEqual([
      'bigquery', 'spanner', 'kc'
    ]);
  });
  test('duplicate tokens are de-duplicated', () => {
    expect(resolveTargets('bq,bq,kc')).toEqual(['bigquery', 'kc']);
    expect(resolveTargets('all,kc')).toEqual(['bigquery', 'spanner', 'kc']);
  });
  test('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(resolveTargets(' BQ , KC ')).toEqual(['bigquery', 'kc']);
  });
  test('an unknown token anywhere in the list resolves to undefined', () => {
    expect(resolveTargets('snowflake')).toBeUndefined();
    expect(resolveTargets('bq,snowflake')).toBeUndefined();
  });
  test(
      'a bare --target (cac yields boolean true) resolves to undefined', () => {
        // cac passes boolean `true` when the flag is given with no value;
        // resolve it to undefined so the caller reports a clean error rather
        // than throwing on `.toLowerCase()`.
        expect(resolveTargets(true as unknown as string)).toBeUndefined();
      });
});
