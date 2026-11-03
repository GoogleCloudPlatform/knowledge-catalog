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
  ['a plain scalar set to two lines', 'a: x  # c\n', v => v.a = 'x\ny'],
  ['a quoted string set to a number', 'a: "x"  # c\n', v => v.a = 5],
  [
    'a JSON file', '{"a": "x", "b": [1, 2], "c": ["yes", "on", "2001-12-14"]}',
    v => (v.a = 'true', v.b[1] = 3)
  ],
  ['an anchor and its alias', 'a: &x {k: 1}  # c\nb: *x\n', v => v.a.k = 2],
  ['an alias of an anchor in a removed item', 'l:\n  - &x a\n  - b\nk: *x\n', v => v.l.shift()],
  [
    'an alias reached before its anchor gains an item', 'a: &s\n  - 1\nb: *s\n',
    v => {
      const a = [...v.a, 2];
      delete v.a;
      v.a = a;
    }
  ],
  [
    'a flow list item renamed to "b, c"', 'f: [{name: a}, {name: b}]  # c\n',
    v => v.f[1].name = 'b, c'
  ],
  [
    'a plain scalar and a flow list of two lines set to mappings',
    'a: x\n  y  # c\nb: [1,\n  2]  # d\n', v => (v.a = {k: 1}, v.b = {k: 2}),
    'a:  # c\n  k: 1\nb:  # d\n  k: 2\n'
  ],
])('%s reads back as the new value', (_, input, change, ...[expected]) => {
  const {document, text} = parseForUpdate(input);
  const value = plainCopy(document.toJS());
  const links = linkNodes(value, document.contents);
  change(value);

  const output = updateText(text, document, value, links);

  expect(yaml.parse(output)).toEqual(value);
  expect(yaml.parse(output, {version: '1.1'})).toEqual(value);
  if (expected) expect(output).toBe(expected);
});
