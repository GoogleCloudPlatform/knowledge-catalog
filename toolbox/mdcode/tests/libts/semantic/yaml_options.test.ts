// Tests for the YAML error messages (yaml_options.ts).

import {expect, test} from 'bun:test';
import * as yaml from 'yaml';

import {yamlErrorMessage} from '../../../src/libts/semantic/yaml_options';

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
