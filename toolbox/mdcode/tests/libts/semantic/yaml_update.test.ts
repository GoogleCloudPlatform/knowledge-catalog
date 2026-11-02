// Tests for changing a parsed YAML document in place (yaml_update.ts).

import {expect, test} from 'bun:test';
import * as yaml from 'yaml';

import {plainCopy} from '../../../src/libts/semantic/resolve_profiles';
import {YAML_OPTIONS} from '../../../src/libts/semantic/yaml_options';
import {linkNodes, updateDocument} from '../../../src/libts/semantic/yaml_update';

// Each row changes a plain copy of `input`. The nodes kept from the input keep
// their quoting and flow style, and the text must still read back as the new
// value.
test.each<[string, string, (value: any) => void]>([
  ['a plain scalar set to "true"', 'a: x  # c\n', v => v.a = 'true'],
  ['a plain scalar set to "a: b #c"', 'a: x  # c\n', v => v.a = 'a: b #c'],
  ['a plain scalar set to two lines', 'a: x  # c\n', v => v.a = 'x\ny'],
  ['a quoted string set to a number', 'a: "x"  # c\n', v => v.a = 5],
  ['a JSON file', '{"a": "x", "b": [1, 2]}', v => (v.a = 'true', v.b[1] = 3)],
  ['an anchor and its alias', 'a: &x {k: 1}  # c\nb: *x\n', v => v.a.k = 2],
  [
    'a flow list item renamed to "b, c"', 'f: [{name: a}, {name: b}]  # c\n',
    v => v.f[1].name = 'b, c'
  ],
])('%s reads back as the new value', (_, input, change) => {
  const doc =
      yaml.parseDocument(input, {...YAML_OPTIONS, keepSourceTokens: true});
  const value = plainCopy(doc.toJS());
  const links = linkNodes(value, doc.contents);
  change(value);

  updateDocument(doc, value, links);

  const text = doc.toString({lineWidth: 0, flowCollectionPadding: false});
  expect(yaml.parse(text)).toEqual(value);
});
