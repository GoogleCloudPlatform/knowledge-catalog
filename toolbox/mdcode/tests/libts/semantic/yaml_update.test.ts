// Tests for changing the text of a YAML document (yaml_update.ts).

import {expect, test} from 'bun:test';
import * as yaml from 'yaml';

import {plainCopy} from '../../../src/libts/semantic/resolve_profiles';
import {linkNodes, parseForUpdate, updateText} from '../../../src/libts/semantic/yaml_update';

// Each row changes a plain copy of `input`. The nodes kept from the input keep
// their quoting and flow style, and the text must still read back as the new
// value, under YAML 1.1 as well. A row with a fourth column must give that
// text.
test.each<[string, string, (value: any) => void, string?]>([
  ['a plain scalar set to "true"', 'a: x  # c\n', v => v.a = 'true'],
  ['a plain scalar set to "a: b #c"', 'a: x  # c\n', v => v.a = 'a: b #c'],
  [
    'a plain scalar set to two lines, the first ending in a space', 'a: x  # c\n',
    v => v.a = 'x \ny'
  ],
  ['a quoted string set to a number', 'a: "x"  # c\n', v => v.a = 5],
  [
    'block scalars set to a number and a mapping', 'a: |-  # c\n  x\nb: |-  # d\n  y\n',
    v => (v.a = 5, v.b = {k: 1}), 'a: 5  # c\nb:  # d\n  k: 1\n'
  ],
  [
    'a JSON file', '{"a": "x", "b": [1, 2], "c": ["yes", "on", "2001-12-14"]}',
    v => (v.a = 'true', v.b[1] = 3)
  ],
  ['an anchor and its alias', 'a: &x {k: 1}  # c\nb: *x\n', v => v.a.k = 2],
  [
    'a mapping whose keys all change, ending in a comment',
    'm:\n  a:\n    b:\n      - x\n      # c\n  d: 1\n', v => v.m.a = {e: v.m.a.b}
  ],
  [
    'a mapping ending in a list and a comment replaced, above a commented key',
    'a:\n  k:\n    - x\n    # deep\n# c\nb: 1\n', v => v.a = {c: v.a.k},
    'a:\n  c:\n    - x\n# c\nb: 1\n'
  ],
  [
    'a block scalar in a CRLF text set to a mapping', 'a: |\r\n  x\r\nb: 1\r\n',
    v => v.a = {c: 1}, 'a:\r\n  c: 1\r\nb: 1\r\n'
  ],
  [
    'moved values keep their text',
    'a:\n  custom:\n    t: [x, z]  # c\n    u: \'z\'\n    "k: 1": \'x\'\n    w:\n      - p  # q\n\n      - r\nc: \'p\'\n',
    v => (v.a = {...v.a.custom}, v.d = {c: 'p'}),
    'a:\n  t: [x, z]\n  u: \'z\'\n  "k: 1": \'x\'\n  w:\n    - p  # q\n\n    - r\nc: \'p\'\nd:\n  c: p\n'
  ],
  [
    'moved values in flow mappings, one that a flow mapping would read differently',
    'a:\n  custom: {t: 1}\n  m: a, b\n  o: \'x\'\nb: {i: 1, o: \'z\'}\n',
    v => (v.a.custom.m = v.a.m, v.a.custom.o = v.a.o, delete v.a.m, delete v.a.o,
          v.b = {i: 1, custom: {o: v.b.o}}),
    'a:\n  custom: {t: 1, m: "a, b", o: \'x\'}\nb: {i: 1, custom: {o: \'z\'}}\n'
  ],
  ['an alias of an anchor in a removed item', 'l:\n  - &x a\n  - b\nk: *x\n', v => v.l.shift()],
  [
    'an alias reached before its anchor gains an item', 'a: &s\n  - 1\nb: *s\n',
    v => {
      const a = [...v.a, 2];
      delete v.a;
      v.a = a;
    }
  ],
  ['the last item removed from a flow list', 'f: [a, b]  # c\n', v => v.f.pop(), 'f: [a]  # c\n'],
  [
    'the last entry of a flow mapping over several lines replaced by a new one',
    'a: {\n  i: x,\n  o: y\n}\n', v => (delete v.a.o, v.a.c = 'z'), 'a: {\n  i: x,\n  c: z\n}\n'
  ],
  [
    'a flow mapping given text of several lines, in a scalar and a new mapping',
    'f: [{name: a, d: x}]\n', v => {
      const text = 'Owned by the analytics team in the main office.\n\nAsk first.';
      v.f[0].d = text;
      v.f[0].e = {k: text};
    }
  ],
  [
    'a flow list item renamed to "b, c"', 'f: [{name: a}, {name: b}]  # c\n',
    v => v.f[1].name = 'b, c'
  ],
  [
    'the last item removed from a CRLF text with no final newline',
    'a:\r\n  - x\r\n  - y', v => v.a.pop(), 'a:\r\n  - x'
  ],
  [
    'the last key of a text with no final newline moved under a new key',
    'a:\n  k: 1\n  t: 2', v => (delete v.a.t, v.a.c = {t: 2}), 'a:\n  k: 1\n  c:\n    t: 2'
  ],
  [
    'a scalar in a padded flow mapping set to a mapping',
    'g: {\n  k: 1}\nf: [{ name: a, e: x }]\n', v => v.f[0].e = {d: [{k: 'x'}]},
    'g: {\n  k: 1}\nf: [{ name: a, e: { d: [{ k: x }] } }]\n'
  ],
  [
    'a first key removed above a comment at column 0',
    'l:\n  - a: 1\n# c\n    b: 2\n', v => delete v.l[0].a, 'l:\n# c\n  - b: 2\n'
  ],
  [
    'a new first key and a new last item in a text with no final newline',
    'l:\n  - b: 1', v => {
      const {b} = v.l[0];
      delete v.l[0].b;
      Object.assign(v.l[0], {a: 0, b});
      v.l.push('y');
    }
  ],
  [
    'a list item removed between comments at its key column',
    'a:\n  - k: 1\n    # c1\n  - k: 2\n    # c2\n  - k: 3\n', v => v.a.splice(1, 1)
  ],
  [
    'a value beside keys whose text is not their value',
    '~: a\n1.0: b\n0x10: c\n02: d\nx: e\n', v => v.x = 'f',
    '~: a\n1.0: b\n0x10: c\n02: d\nx: f\n'
  ],
  [
    'values of two lines and flow collections replaced by other kinds',
    'a: x\n  y  # c\nb: [1,\n  2]  # d\nm: {b: 1}  # e\nl: [1, 2]\n',
    v => (v.a = {k: 1}, v.b = 'z', v.m = {c: 1}, v.l = {a: 1}),
    'a:  # c\n  k: 1\nb: z  # d\nm: {c: 1}  # e\nl: {a: 1}\n'
  ],
])('%s reads back as the new value', (_, input, change, ...[expected]) => {
  const {document, text} = parseForUpdate(input);
  const value = plainCopy(document.toJS());
  const links = linkNodes(value, document.contents);
  change(value);

  const output = updateText(text, document, value, links);

  expect(yaml.parse(output)).toEqual(value);
  expect(yaml.parse(output, {version: '1.1'})).toEqual(value);
  expect(output.endsWith('\n')).toBe(text.endsWith('\n'));
  if (expected) expect(output).toBe(expected);
});
