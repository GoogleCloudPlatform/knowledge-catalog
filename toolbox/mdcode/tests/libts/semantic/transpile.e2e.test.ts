// End-to-end golden test for the transpile pass: file -> IR -> transpile ->
// BigQuery DDL, with the REAL sqlglot mechanism.
//
// This is the transpiled counterpart to bigquery.e2e.test.ts. That golden
// (`vendor_dialects.bigquery.golden.sql`) captures the UN-transpiled output --
// vendor SQL emitted verbatim because the loader left `expression` unset. This
// one captures what `kcmd push --transpile` produces instead: the same model
// after the pass fills each missing target `expression` from its
// `importedExpression`, so the DDL carries GoogleSQL. Every expression in the
// golden was dry-run-validated against real BigQuery (see the fixture header).
//
// It is GATED on sqlglot being importable through the adapter -- the golden is
// a function of sqlglot's output, so it can only be checked (or regenerated)
// where sqlglot is installed. On a machine without it the test skips rather
// than fails.
//
//   Regenerate after an intentional change (needs sqlglot):
//     KCMD_PYTHON=/path/to/venv/bin/python UPDATE_GOLDENS=1 \
//       bun test ./tests/libts/semantic/transpile.e2e.test.ts
//   then read the diff before committing.

import {describe, expect, test} from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

import {generatePropertyGraph} from '../../../src/libts/semantic/bigquery';
import {loadModels} from '../../../src/libts/semantic/loader';
import {sqlglotInstalled, transpileModel} from '../../../src/libts/semantic/transpile';

const FIXTURES = path.join(__dirname, 'fixtures');
const FIXTURE = 'vendor_dialects.yaml';
const GOLDEN =
    path.join(FIXTURES, 'vendor_dialects.bigquery.transpiled.golden.sql');

const AVAILABLE = sqlglotInstalled();

// The full artifact: DDL generated from the transpiled model, then every
// warning as a SQL comment. Mirrors bigquery.e2e's render but inserts the
// transpile pass and drops the loader's now-stale "needs transpilation" notes,
// exactly as `kcmd push --transpile` does (see src/tool/commands.ts).
async function render(): Promise<string> {
  const text = fs.readFileSync(path.join(FIXTURES, FIXTURE), 'utf8');
  const {models, warnings: loadWarnings} = loadModels(
      text, {defaultProject: 'sqlgen-testing', defaultDataset: 'demo'});
  const {model, warnings: transpileWarnings} = await transpileModel(models[0]);
  const {ddl, warnings: genWarnings} = generatePropertyGraph(
      model, {project: 'sqlgen-testing', dataset: 'demo'});

  const keptLoad = loadWarnings.filter(w => !w.includes('needs transpilation'));
  const warnings = [...keptLoad, ...transpileWarnings, ...genWarnings];
  const warnBlock =
      warnings.length ? warnings.map(w => `-- ${w}`).join('\n') : '-- (none)';
  return `${ddl}\n-- warnings --\n${warnBlock}\n`;
}

describe('golden DDL: vendor_dialects transpiled to GoogleSQL', () => {
  test.skipIf(!AVAILABLE)(
      'matches the committed transpiled golden', async () => {
        const actual = await render();
        if (process.env.UPDATE_GOLDENS) {
          fs.writeFileSync(GOLDEN, actual);
          return;
        }
        const expected = fs.readFileSync(GOLDEN, 'utf8');
        expect(actual).toBe(expected);
      });
});
