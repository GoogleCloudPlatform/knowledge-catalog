// Tests for the name patterns and limits in src/libts/semantic/names.ts.

import {describe, expect, test} from 'bun:test';

import {MAX_ENTRY_DESCRIPTION, NameKind, nameProblem} from '../../../src/libts/semantic/names';

const KINDS: NameKind[] =
    ['model', 'profile', 'deployment', 'entity', 'metric', 'relationship', 'field'];
const WITH_HYPHEN: NameKind[] = ['model', 'profile', 'deployment'];
const IN_SQL: NameKind[] = ['entity', 'metric', 'relationship'];

describe('nameProblem', () => {
  test('each kind accepts a plain name and rejects a slash, a leading digit or a space', () => {
    for (const kind of KINDS) {
      expect(nameProblem(kind, 'orders_2024')).toBeUndefined();
      for (const bad of ['sales/orders', '2024_orders', 'order date', '*', 'prod,us', '']) {
        expect(nameProblem(kind, bad)).toContain(`name '${bad}' is not valid`);
      }
    }
  });

  test('a hyphen is accepted in a model, profile or deployment name only', () => {
    for (const kind of WITH_HYPHEN) {
      expect(nameProblem(kind, 'sales-analytics')).toBeUndefined();
    }
    for (const kind of [...IN_SQL, 'field'] as NameKind[]) {
      expect(nameProblem(kind, 'my-entity')).toContain(`name 'my-entity' is not valid`);
    }
  });

  test('a leading underscore is accepted in a field name only', () => {
    expect(nameProblem('field', '_partition')).toBeUndefined();
    for (const kind of KINDS.filter(k => k !== 'field')) {
      expect(nameProblem(kind, '_orders')).toContain(`name '_orders' is not valid`);
    }
  });

  test('a name may have 500 characters, a field name 300', () => {
    for (const kind of KINDS) {
      const max = kind === 'field' ? 300 : 500;
      expect(nameProblem(kind, 'a'.repeat(max))).toBeUndefined();
      expect(nameProblem(kind, 'a'.repeat(max + 1)))
          .toContain(`is ${max + 1} characters long; names may be at most ${max} characters.`);
    }
  });

  test('a long name is cut by whole characters in the message', () => {
    // Each emoji is two UTF-16 code units. After the leading 'a', a cut at 40
    // code units would end inside the 20th emoji; a cut at 40 characters keeps
    // 'a' and 39 whole emoji.
    const name = 'a' + '\u{1F600}'.repeat(260);
    expect(nameProblem('entity', name))
        .toStartWith(`Entity name 'a${'\u{1F600}'.repeat(39)}...' is 521 characters long`);
  });

  test('the message names the kind, the pattern and what it allows', () => {
    expect(nameProblem('entity', 'sales/orders')).toBe(
        "Entity name 'sales/orders' is not valid; names must match " +
        '^[A-Za-z][A-Za-z0-9_]*$: a letter, then letters, digits or underscores.');
    expect(nameProblem('model', 'sales/orders')).toBe(
        "Model name 'sales/orders' is not valid; names must match " +
        '^[A-Za-z][A-Za-z0-9_-]*$: a letter, then letters, digits, underscores or hyphens.');
    expect(nameProblem('field', 'order date')).toBe(
        "Field name 'order date' is not valid; names must match " +
        '^[A-Za-z_][A-Za-z0-9_]{0,299}$: a letter or underscore, then letters, digits or ' +
        'underscores.');
  });

  test('a catalog entry description holds 2,000 characters', () => {
    expect(MAX_ENTRY_DESCRIPTION).toBe(2000);
  });
});
