// End-to-end tests for the Spanner destination: real-shaped fixtures run the
// full file -> IR -> DDL path.
//
// Mirrors bigquery.e2e.test.ts. For every fixture below, the complete generated
// DDL plus the emitted warnings are compared byte-for-byte against a committed
// `<fixture>.spanner.golden.sql`. The goldens are the reviewable "big picture":
// open a `.yaml` next to its `.spanner.golden.sql` to see the full input and
// output. Note the corpus is shared with the BigQuery suite, so the two goldens
// side by side show exactly how the same model lowers to each backend --
// including what Spanner drops (measures, per-element OPTIONS) and how it
// references bare table names.
//
//   Regenerate goldens after an intentional generator change:
//     UPDATE_GOLDENS=1 npx bun test ./tests/libts/semantic/spanner.e2e.test.ts
//   then read the diff before committing.

import {describe, expect, test} from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

import {loadModels, LoadOptions} from '../../../src/libts/semantic/loader';
import {generateSpannerPropertyGraph} from '../../../src/libts/semantic/spanner';

const FIXTURES = path.join(__dirname, 'fixtures');

// A subset of the BigQuery corpus that exercises the Spanner-relevant shapes:
// a basic star (nodes + a direct-FK edge, with metrics that Spanner drops), a
// class hierarchy (DEFAULT LABEL + inherited LABEL blocks), and a multi-edge
// fan-out.
const CORPUS = [
  'star_orders_customer.yaml',
  'hierarchy_graph.yaml',
  'sales_fanout.yaml',
  'reserved_words.yaml',
];

function loadFixture(fixture: string, load: LoadOptions = {}) {
  const text = fs.readFileSync(path.join(FIXTURES, fixture), 'utf8');
  return loadModels(
      text,
      {defaultProject: 'sqlgen-testing', defaultDataset: 'demo', ...load});
}

function build(fixture: string, load: LoadOptions = {}) {
  const {models, warnings: loadWarnings} = loadFixture(fixture, load);
  const {ddl, warnings: genWarnings} = generateSpannerPropertyGraph(models[0]);
  return {models, ddl, loadWarnings, genWarnings};
}

// The exact artifact a golden captures: the full DDL, then every warning (load
// + generate) as SQL comments so a reviewer sees dropped/flagged elements too.
function render(fixture: string): string {
  const {ddl, loadWarnings, genWarnings} = build(fixture);
  const warnings = [...loadWarnings, ...genWarnings];
  const warnBlock =
      warnings.length ? warnings.map(w => `-- ${w}`).join('\n') : '-- (none)';
  return `${ddl}\n-- warnings --\n${warnBlock}\n`;
}

const goldenPath = (fixture: string) =>
    path.join(FIXTURES, fixture.replace(/\.yaml$/, '.spanner.golden.sql'));


describe(
    'golden DDL: each corpus fixture generates its exact expected Spanner property graph',
    () => {
      for (const fixture of CORPUS) {
        test(fixture, () => {
          const actual = render(fixture);
          const golden = goldenPath(fixture);
          if (process.env.UPDATE_GOLDENS) {
            fs.writeFileSync(golden, actual);
            return;
          }
          if (!fs.existsSync(golden)) {
            throw new Error(`missing golden ${
                path.basename(golden)} — run UPDATE_GOLDENS=1 to create it`);
          }
          expect(actual).toBe(fs.readFileSync(golden, 'utf8'));
        });
      }
    });


describe('Spanner Graph drops what it cannot express', () => {
  test('model-level metrics are not emitted, and each is warned', () => {
    // Spanner Graph has no MEASURE, so the star fixture's two metrics are
    // dropped -- the graph structure (nodes, the edge) still generates.
    const {ddl, genWarnings} = build('star_orders_customer.yaml');
    expect(ddl).not.toContain('MEASURE');
    expect(ddl).not.toContain('total_revenue');
    expect(genWarnings)
        .toContain(
            'metric \'total_revenue\' is not emitted: Spanner Graph has no ' +
            'MEASURE, so model-level metrics have no home in it');
    expect(genWarnings)
        .toContain(
            'metric \'order_count\' is not emitted: Spanner Graph has no ' +
            'MEASURE, so model-level metrics have no home in it');
  });

  test('no per-element OPTIONS clause is emitted', () => {
    // BigQuery attaches description/synonyms as OPTIONS on labels/properties;
    // Spanner Graph has no such clause, so none appears.
    const {ddl} = build('star_orders_customer.yaml');
    expect(ddl).not.toContain('OPTIONS(');
  });

  test(
      'input tables are referenced by their bare name, not project.dataset',
      () => {
        // The star fixture's `orders` entity sources `samples.tpch.orders`; the
        // Spanner graph names it by the final segment only.
        const {ddl} = build('star_orders_customer.yaml');
        expect(ddl).toContain('orders AS orders');
        expect(ddl).not.toContain('samples.tpch.orders');
        expect(ddl).toContain('CREATE OR REPLACE PROPERTY GRAPH sales');
      });
});
