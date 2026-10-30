// Tests the OKF concept-file reader/writer (src/libts/okf/concept.ts).
//
// The cases that matter are the ones where a careless implementation silently
// edits the author's document: a timestamp coerced to a Date, a `null`
// dropped, or a producer's own key reordered away.

import {describe, expect, test} from 'bun:test';

import {conceptToFileContent, fileContentToConcept, RESIDUE_KEY} from '../../../src/libts/okf/concept';

/** A concept with the given frontmatter and a one-line body. */
function c(frontmatter: Record<string, unknown>) {
  return {id: 'a', frontmatter, body: 'body\n'};
}

describe('fileContentToConcept', () => {
  test('splits frontmatter from body', () => {
    const f = fileContentToConcept(
        '---\ntype: BigQuery Table\ntitle: trips\n---\n# Heading\n\nProse.\n', 'a');
    expect(f.id).toBe('a');
    expect(f.frontmatter).toEqual({type: 'BigQuery Table', title: 'trips'});
    expect(f.body).toBe('# Heading\n\nProse.\n');
  });

  test('a body-only file is valid, not an error', () => {
    const f = fileContentToConcept('# Austin Bikeshare\n\n* [a](a.md)\n', 'a');
    expect(f.frontmatter).toEqual({});
    expect(f.body).toBe('# Austin Bikeshare\n\n* [a](a.md)\n');
  });

  test('an unterminated block is treated as body, not thrown', () => {
    const f = fileContentToConcept('---\ntype: X\nno closing delimiter\n', 'a');
    expect(f.body).toBe('---\ntype: X\nno closing delimiter\n');
  });

  test('keeps an ISO instant as a string', () => {
    // Parsing to a Date and dumping back rewrites `2026-09-20T18:23:53Z` as
    // `2026-09-20 18:23:53+00:00`, losing the offset form SPEC §5 requires.
    const f = fileContentToConcept(
        '---\ngenerated:\n  at: 2026-09-20T18:23:53Z\n---\nbody\n', 'a');
    const generated = f.frontmatter['generated'] as {at: unknown};
    expect(typeof generated.at).toBe('string');
    expect(generated.at).toBe('2026-09-20T18:23:53Z');
  });

  test('a non-mapping block yields empty frontmatter', () => {
    expect(fileContentToConcept('---\n- a\n- b\n---\nbody\n', 'a').frontmatter)
        .toEqual({});
  });
});

describe('conceptToFileContent', () => {
  test('emits OKF keys in spec order regardless of input order', () => {
    const out = conceptToFileContent(
        c({title: 'trips', type: 'BigQuery Table', status: 'stable'}));
    expect(out.split('\n').slice(1, 4)).toEqual(
        ['type: BigQuery Table', 'title: trips', 'status: stable']);
  });

  test('keeps producer extensions, after the known keys', () => {
    const out = conceptToFileContent(c({'x-producer-note': 'keep me', type: 'Metric'}));
    expect(out).toContain('x-producer-note: keep me');
    expect(out.indexOf('type:')).toBeLessThan(out.indexOf('x-producer-note:'));
  });

  test('forces the residue block last', () => {
    const out = conceptToFileContent(c({[RESIDUE_KEY]: {v: 1}, type: 'Metric', 'x-other': 1}));
    expect(out.indexOf(RESIDUE_KEY)).toBeGreaterThan(out.indexOf('x-other'));
  });

  test('drops undefined but keeps an explicit null', () => {
    const out = conceptToFileContent(c({type: 'Metric', gone: undefined, license: null}));
    expect(out).not.toContain('gone');
    expect(out).toContain('license: null');
  });

  test('adds a trailing newline to a body missing one', () => {
    expect(conceptToFileContent({id: 'a', frontmatter: {type: 'Metric'}, body: 'no newline'}))
        .toEndWith('no newline\n');
  });
});

describe('round trip', () => {
  test('a document survives unchanged', () => {
    const text = '---\ntype: BigQuery Table\ntitle: trips\nsources:\n' +
        '  - id: data-profile\n    resource: bq://p.d.t\n---\n# Trips\n\nProse.\n';
    const f = fileContentToConcept(text, 'a');
    expect(conceptToFileContent(f)).toBe(text);
  });
});
