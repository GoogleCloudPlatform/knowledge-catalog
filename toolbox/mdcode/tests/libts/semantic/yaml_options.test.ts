// Tests for the YAML error messages (yaml_options.ts).

import {expect, test} from 'bun:test';
import * as yaml from 'yaml';

import {YAML_OPTIONS, yamlErrorMessage} from '../../../src/libts/semantic/yaml_options';

// The text above the YAML text may end inside a line. The position and the
// hint for an unquoted `*` both read that line in the file.
test('places a YAML error after text above it that ends inside a line', () => {
  const [err] = yaml.parseDocument('*').errors;
  expect(yamlErrorMessage(err, '*', 'metrics_exclude: '))
      .toBe(
          'Alias cannot be an empty string at line 1, column 18:\n\n' +
          'metrics_exclude: *\n                 ^\n' +
          "YAML reads an unquoted '*' as an alias; write it in quotes, as in " +
          'metrics_exclude: "*".');
});

// An error that reports a `[` or `{` left open points at it, though YAML
// places the error before the spaces and line breaks that end it. That
// includes a `{` whose later `}` YAML does not read as its end. Any other
// error keeps YAML's place, even where a value left open ends.
const FLOW_MAP = 'Flow map in block collection must be sufficiently ' +
    'indented and end with a }';
const FLOW_SEQ = 'Flow sequence in block collection must be sufficiently ' +
    'indented and end with a ]';
test.each([
  ['a flow map ending in a key with no value',
   'version: "0.2.0.dev0/google"\nsemantic_model:\n  - name: retail\n' +
       '    ai_context: {\n      owner: sales,\n      notes:\n' +
       '    entities: []\n',
   `${FLOW_MAP} at line 4, column 17:\n\n    ai_context: {\n` +
       '                ^\n'],
  ['a root flow map ending in a key with no value', '{"a":\n',
   'Flow map must end with a } at line 1, column 1:\n\n{"a":\n^\n'],
  ['a flow sequence ending in a key with no value', 'a: [x:\n',
   `${FLOW_SEQ} at line 1, column 4:\n\na: [x:\n   ^\n`],
  ['a flow map ending in an anchor with no value', 'a: {k: &q\n',
   `${FLOW_MAP} at line 1, column 4:\n\na: {k: &q\n   ^\n`],
  ['a flow sequence closed by } inside a flow map left open',
   'a: {k: [x, y}\n', `${FLOW_SEQ} at line 1, column 13:\n\na: {k: [x, y}\n` +
       '            ^\n'],
  ['a flow map whose } sits under its parent key', 'a:\n  b: {\n    k: v\n}\n',
   `${FLOW_MAP} at line 2, column 6:\n\n  b: {\n     ^\n`],
  ['a flow map with a line indented less than its key',
   'a:\n  b: {\n    k1: v1,\n  k2: v2\n    }\n',
   `${FLOW_MAP} at line 2, column 6:\n\n  b: {\n     ^\n`],
  ['a flow map left open before a } in a block scalar',
   'a: {k: v\nb: |\n  }\n', `${FLOW_MAP} at line 1, column 4:\n\na: {k: v\n   ^\n`],
  ['a flow map left open before a } in a plain value', 'a: {k: v\nb: foo}\n',
   `${FLOW_MAP} at line 1, column 4:\n\na: {k: v\n   ^\n`],
  ['a flow map left open before a list of flow maps',
   'a: {k: v\nb: x\nc:\n  - { name: n, expression: e }\n',
   `${FLOW_MAP} at line 1, column 4:\n\na: {k: v\n   ^\n`],
  ['a flow map left open around a flow map closed under its key',
   "a: {\n  b: {\n    k: the '90s\n  }\n",
   `${FLOW_MAP} at line 1, column 4:\n\na: {\n   ^\n`],
  ['a flow sequence left open inside a flow map a later } ends',
   'a: {\n  k: [1, 2\n}\n',
   `${FLOW_SEQ} at line 2, column 6:\n\n  k: [1, 2\n     ^\n`],
  ['an indent error where a flow sequence left open ends', '? [1, 2\n: 1\n',
   'All mapping items must start at the same column at line 2, column 1:' +
       '\n\n? [1, 2\n: 1\n^\n'],
])('reports %s', (_, text, message) => {
  const [err] = yaml.parseDocument(text, YAML_OPTIONS).errors;
  expect(yamlErrorMessage(err, text)).toBe(message);
});

const LONG_LINE = 'contentType: MARKDOWN\n' + 'b'.repeat(100) + '\n';
// Each row gives a YAML error, its text, the text above it and the expected
// message.
test.each([
  // An overview sidecar's frontmatter sits below its `---` line. The carets
  // under a line longer than 80 characters stop at the snippet's 80th column.
  ["a long line in an overview sidecar's frontmatter",
   yaml.parseDocument(LONG_LINE).errors[0], LONG_LINE, '---\n',
   'Implicit map keys need to be followed by map values at line 3, ' +
       `column 1:\n\ncontentType: MARKDOWN\n${'b'.repeat(79)}…\n` +
       `${'^'.repeat(80)}\n`],
  // kcmd reports none of the errors below. An error with no position text
  // keeps its message. So does an error at position -1, even when its message
  // ends in ' at line 0, column -1', the text positionText computes for that
  // position. YAML adds no snippet for an error on a first line of only
  // spaces. The message then gives the error's line and snippet in the file.
  ['an error parsed without pretty errors',
   yaml.parseDocument('a: "x\n', {...YAML_OPTIONS, prettyErrors: false})
       .errors[0],
   'a: "x\n', '', 'Missing closing "quote'],
  ['an error at position -1',
   new yaml.YAMLParseError(
       [-1, -1], 'MISSING_CHAR', 'Missing closing "quote at line 0, column -1'),
   'a: "x\n', '---\n', 'Missing closing "quote at line 0, column -1'],
  ['an error on a first line of only spaces',
   new yaml.YAMLParseError(
       [1, 2], 'BAD_INDENT', 'Bad indent at line 1, column 2'),
   '   \n', '---\n', 'Bad indent at line 2, column 2:\n\n---\n   \n ^\n'],
])('reports %s', (_, err, text, above, message) => {
  expect(yamlErrorMessage(err, text, above)).toBe(message);
});
