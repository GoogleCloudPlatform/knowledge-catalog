// End-to-end tests for the BigQuery destination: real-shaped fixtures run the
// full file -> IR -> DDL path.
//
// The primary check is a GOLDEN test: for every fixture under `fixtures/`, the
// complete generated DDL plus the emitted warnings are compared byte-for-byte
// against a committed `<fixture>.bigquery.golden.sql` (destination-scoped, so
// other output targets can add their own goldens per fixture). The golden files
// are the reviewable "big picture" — open a `.yaml` next to its
// `.bigquery.golden.sql` to see the full input and full output of the
// translation, and any dropped metric, reordered block, or changed OPTIONS
// shows up as a diff.
//
//   Regenerate goldens after an intentional generator change:
//     UPDATE_GOLDENS=1 npx bun test ./tests/libts/semantic/bigquery.e2e.test.ts
//   then read the diff before committing.
//
// The focused tests below the golden loop cover only what a golden cannot make
// self-evident: emitted warnings, negative behavior (something deliberately
// absent), and the fan-out measure-placement invariant. Pure "this substring
// appears" checks are intentionally omitted — the goldens subsume them.
//
// Unit-level tests for the same generator (inline IR, inline goldens) live in
// `bigquery.test.ts`.

import {describe, expect, test} from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

import {generatePropertyGraph} from '../../../src/libts/semantic/bigquery';
import {loadModels, LoadOptions} from '../../../src/libts/semantic/loader';

const FIXTURES = path.join(__dirname, 'fixtures');

// Every fixture that gets a golden. New fixtures are added here.
const CORPUS = [
  'star_orders_customer.yaml',
  'lineitem_databricks_ext.yaml',
  'tpcds_retail.yaml',
  'tpcds_date_edge.yaml',
  'sales_fanout.yaml',
  'vendor_dialects.yaml',
  'measure_lowering.yaml',
  'metric_skips.yaml',
  'keyless_dimension.yaml',
];

// Loads a fixture file and generates its property-graph DDL in one step, so a
// test can assert over both the load warnings and the emitted DDL.
function build(fixture: string, load: LoadOptions = {}) {
  const text = fs.readFileSync(path.join(FIXTURES, fixture), 'utf8');
  const opts = {
    defaultProject: 'sqlgen-testing',
    defaultDataset: 'demo',
    ...load
  };
  const {models, warnings: loadWarnings} = loadModels(text, opts);
  const {ddl, warnings: genWarnings} = generatePropertyGraph(
      models[0], {project: 'sqlgen-testing', dataset: 'demo'});
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

// Goldens are destination-scoped: `<fixture>.bigquery.golden.sql`. Other output
// destinations will add their own `<fixture>.<destination>.golden.<ext>`.
const goldenPath = (fixture: string) =>
    path.join(FIXTURES, fixture.replace(/\.yaml$/, '.bigquery.golden.sql'));


describe(
    'golden DDL: each corpus fixture generates its exact expected property graph',
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


describe('dialect selection is surfaced by risk when the target dialect is absent', () => {
  test(
      'an ANSI-only model emits one informational note, not a per-field warning',
      () => {
        // The star fixture supplies only ANSI_SQL; the default target is
        // BIGQUERY. Falling back to the portable canonical dialect is the
        // intended path, so it collapses to a single note however many
        // expressions rely on it.
        const {loadWarnings} = build('star_orders_customer.yaml');
        const notes = loadWarnings.filter(
            w => w.includes('using the portable \'ANSI_SQL\''));
        expect(notes).toEqual([
          'note: no \'BIGQUERY\' dialect for one or more expressions; using the portable \'ANSI_SQL\' dialect verbatim (\'BIGQUERY\' accepts the ANSI core subset — supply \'BIGQUERY\' variants only for BIGQUERY-specific SQL)',
        ]);
      });

  test(
      'with no ANSI fallback, the vendor dialect is kept as imported and warned per metric',
      () => {
        // The lineitem fixture supplies only DATABRICKS: neither BIGQUERY nor
        // the ANSI_SQL canonical fallback exists, so the loader keeps
        // DATABRICKS as the imported expression (target `expression` awaits a
        // transpile pass) and warns — a vendor dialect is a genuine
        // transpilation risk.
        const {loadWarnings} = build('lineitem_databricks_ext.yaml');
        expect(loadWarnings)
            .toContain(
                'metric \'revenue\': no \'BIGQUERY\' or \'ANSI_SQL\' dialect; keeping the \'DATABRICKS\' expression as imported_expression (needs transpilation to \'BIGQUERY\')');
      });

  test(
      'selecting the matching dialect explicitly produces no fallback note',
      () => {
        const {loadWarnings} =
            build('star_orders_customer.yaml', {dialect: 'ANSI_SQL'});
        expect(loadWarnings.filter(
                   w => w.includes('using the portable \'ANSI_SQL\'')))
            .toEqual([]);
      });
});


describe('vendor escape hatches are accepted and ignored, not fatal', () => {
  // The lineitem fixture carries custom_extensions at
  // field/relationship/metric/ model level and unique_keys on a dataset with no
  // primary_key. None of these are part of the supported subset; the loader
  // must accept and skip them.
  const {models, loadWarnings} = build('lineitem_databricks_ext.yaml');

  test(
      'the model still loads despite custom_extensions and unique_keys', () => {
        expect(models).toHaveLength(1);
        expect(models[0].entities.map(e => e.name)).toEqual([
          'lineitem', 'orders'
        ]);
      });

  test('a dataset with only unique_keys (no primary_key) is warned about', () => {
    expect(loadWarnings)
        .toContain(
            'dataset \'orders\': no primary_key; the entity\'s KEY will be empty (invalid for graph generation)');
  });
});


describe('cross-dataset metrics are flagged, not silently dropped', () => {
  test(
      'a ratio spanning two tables is skipped with a reason (Phase B will decompose it)',
      () => {
        // Until GRAPH_EXPAND decomposition lands, a metric whose aggregate
        // spans two tables cannot be a single MEASURE; the generator must flag
        // it, not drop it silently. (The golden records the same skip; this
        // pins the exact reason.)
        const {genWarnings} = build('tpcds_retail.yaml');
        expect(genWarnings)
            .toContain(
                'metric \'customer_lifetime_value\' spans multiple tables (store_sales, customer); skipped (cannot be a single MEASURE)');
        expect(genWarnings)
            .toContain(
                'metric \'store_productivity\' spans multiple tables (store_sales, store); skipped (cannot be a single MEASURE)');
      });
});


describe('a field with no metadata is emitted bare', () => {
  test('no OPTIONS clause is attached to a plain column', () => {
    const {ddl} = build('star_orders_customer.yaml');
    expect(ddl).toContain('o_custkey,\n');
    expect(ddl).not.toContain('o_custkey OPTIONS');
  });
});


describe(
    'measure lowering exposes each operand once (a golden shows the shape; this pins the reuse)',
    () => {
      test(
          'an identical inline operand is exposed as one derived property, reused by both measures',
          () => {
            // `fulfilled` and `avg_fulfilled` share the same IF(...) operand;
            // it must be lowered to a single `fulfilled_input` property, not
            // duplicated per metric.
            const {ddl, loadWarnings, genWarnings} =
                build('measure_lowering.yaml');
            expect(ddl.match(/AS fulfilled_input/g)?.length).toBe(1);
            expect(ddl).toContain('MEASURE(SUM(fulfilled_input)) AS fulfilled');
            expect(ddl).toContain(
                'MEASURE(AVG(fulfilled_input)) AS avg_fulfilled');
            expect(ddl).not.toContain('avg_fulfilled_input');
            // A qualifier inside a string literal is preserved, not stripped as
            // a column.
            expect(ddl).toContain('\'orders.note\'');
            // A single, fully-specified entity places every metric cleanly.
            expect([...loadWarnings, ...genWarnings]).toEqual([]);
          });
    });


describe(
    'unplaceable metrics are skipped with a specific reason (pinned beyond the golden)',
    () => {
      test('each skip reason is surfaced verbatim', () => {
        const {genWarnings} = build('metric_skips.yaml');
        expect(genWarnings)
            .toContain(
                'metric \'clv\' spans multiple tables (orders, customers); skipped (cannot be a single MEASURE)');
        expect(genWarnings)
            .toContain(
                'metric \'status\' collides with an existing property of entity \'orders\'; skipped (rename the metric to avoid a duplicate graph property)');
        expect(genWarnings.some(
                   w => w.includes('metric \'spread\'') &&
                       w.includes('not a single supported aggregate')))
            .toBe(true);
      });
    });


describe(
    'measure placement over a fan-out (the reason goldens alone are not enough)',
    () => {
      const {models, loadWarnings, genWarnings} = build('sales_fanout.yaml');

      test(
          'a fully-specified model loads and generates with no warnings',
          () => {
            expect(models).toHaveLength(1);
            expect([...loadWarnings, ...genWarnings]).toEqual([]);
          });

      test(
          'a count metric lands on its own entity node, not the fan-out table',
          () => {
            // order_count counts orders, so it must sit on the `orders` node
            // (keyed by order_id) — this is what makes GRAPH_EXPAND + AGG
            // return 3 orders for the west region rather than 4 (the
            // order_items count). Verified live.
            const {ddl} = build('sales_fanout.yaml');
            const ordersBlock = ddl.slice(
                ddl.indexOf('AS orders\n'), ddl.indexOf('AS order_items'));
            expect(ordersBlock)
                .toContain('MEASURE(COUNT(order_id)) AS order_count');
          });
    });
