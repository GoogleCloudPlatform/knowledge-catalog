// Tests for the line-based three-way merge (src/libts/semantic/text_merge.ts)
// that keeps a model file's formatting through an edit.

import {describe, expect, test} from 'bun:test';

import {diffLines, mergeFormatting} from '../../../src/libts/semantic/text_merge';

// Applies diffLines' hunks to `a`.
function apply(a: string[], b: string[]): string[] {
  const out: string[] = [];
  let at = 0;
  for (const h of diffLines(a, b)) {
    out.push(...a.slice(at, h.start), ...h.lines);
    at = h.end;
  }
  return [...out, ...a.slice(at)];
}

describe('diffLines', () => {
  const cases: Array<[string, string]> = [
    ['', ''],
    ['a', ''],
    ['', 'a'],
    ['a b c', 'a b c'],
    ['a b c', 'a x c'],
    ['a b c d e', 'b c e f'],
    ['x a b c y', 'a b c'],
    ['a a a b', 'a b b b'],
    ['k1 v1 k2 v2 k3 v3', 'k1 v1 k2 V2 k3 v3 k4 v4'],
  ];
  for (const [a, b] of cases) {
    test(`turns '${a}' into '${b}'`, () => {
      const lines = (s: string) => s ? s.split(' ') : [];
      expect(apply(lines(a), lines(b))).toEqual(lines(b));
    });
  }

  test('gives one hunk per changed run', () => {
    expect(diffLines(['a', 'b', 'c', 'd'], ['a', 'B', 'c', 'd', 'e'])).toEqual([
      {start: 1, end: 2, lines: ['B']},
      {start: 4, end: 4, lines: ['e']},
    ]);
  });
});

describe('mergeFormatting', () => {
  // The file as written, as the YAML library re-renders it, and the
  // re-rendering after an edit that appends a field.
  const original = [
    'keys: [ a, b ]  # the key',
    'fields:',
    '  - name: a',
    '  - name: b',
    '',
  ].join('\n');
  const rendered = [
    'keys: [a, b] # the key',
    'fields:',
    '  - name: a',
    '  - name: b',
    '',
  ].join('\n');

  test('keeps the lines the edit did not change as written', () => {
    const edited = rendered.replace('  - name: b\n', '  - name: b\n  - name: c\n');
    expect(mergeFormatting(original, rendered, edited))
        .toBe(original.replace('  - name: b\n', '  - name: b\n  - name: c\n'));
  });

  test('takes the edit where it changed a line the rendering changed', () => {
    const edited = rendered.replace('keys: [a, b]', 'keys: [a]');
    expect(mergeFormatting(original, rendered, edited)).toBe(edited);
  });

  test('takes the edit for a run next to a line the rendering changed', () => {
    const edited = rendered.replace('fields:', 'fields: []\nmore:');
    expect(mergeFormatting(original, rendered, edited)).toBe(edited);
  });

  test('gives the file back when there is no edit', () => {
    expect(mergeFormatting(original, rendered, rendered)).toBe(original);
  });

  test('gives the edit when the rendering matches the file', () => {
    expect(mergeFormatting(rendered, rendered, 'x: 1\n')).toBe('x: 1\n');
  });

  test('keeps CRLF line endings', () => {
    const edited = rendered.replace('  - name: b\n', '  - name: b\n  - name: c\n');
    expect(mergeFormatting(original.replace(/\n/g, '\r\n'), rendered, edited))
        .toBe(original.replace('  - name: b\n', '  - name: b\n  - name: c\n')
                  .replace(/\n/g, '\r\n'));
  });
});
