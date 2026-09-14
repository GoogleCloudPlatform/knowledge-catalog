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

import * as yaml from 'yaml';

import {generatePropertyGraph} from '../../../src/libts/semantic/bigquery';
import {loadModels, loadSemanticModels, LoadOptions} from '../../../src/libts/semantic/loader';
import {mergeProfile, pruneUnavailable} from '../../../src/libts/semantic/resolve_profiles';

const FIXTURES = path.join(__dirname, 'fixtures');

// Every fixture that gets a golden. New fixtures are added here.
const CORPUS = [
  'star_orders_customer.yaml',
  'tpcds_retail.yaml',
  'tpcds_date_edge.yaml',
  'sales_fanout.yaml',
  'vendor_dialects.yaml',
  'measure_lowering.yaml',
  'metric_skips.yaml',
  'keyless_dimension.yaml',
  'hierarchy_graph.yaml',
  'reserved_words.yaml',
  'reserved_words_inherit.yaml',
];

// Loads a fixture file to its IR. Split out from `build` so a test that only
// cares about load behavior (dialect fallback, vendor escape hatches) does not
// also run generation — which now throws for a model that yields no node table.
function loadFixture(fixture: string, load: LoadOptions = {}) {
  const text = fs.readFileSync(path.join(FIXTURES, fixture), 'utf8');
  return loadModels(
      text,
      {defaultProject: 'sqlgen-testing', defaultDataset: 'demo', ...load});
}

// Loads a fixture file and generates its property-graph DDL in one step, so a
// test can assert over both the load warnings and the emitted DDL.
function build(fixture: string, load: LoadOptions = {}) {
  const {models, warnings: loadWarnings} = loadFixture(fixture, load);
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
        const {warnings: loadWarnings} =
            loadFixture('lineitem_databricks_ext.yaml');
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
  const {models, warnings: loadWarnings} =
      loadFixture('lineitem_databricks_ext.yaml');

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


// Splits the NODE TABLES(...) section into one string per node table (its alias
// plus everything up to the next node or the section close).
function nodeBlocks(ddl: string): Array<{alias: string; body: string}> {
  const start = ddl.indexOf('NODE TABLES (');
  if (start < 0) return [];
  // The section closes at the first `)` in column 0 after it (PROPERTIES closes
  // at indent 2, so it never matches).
  const end = ddl.indexOf('\n)', start);
  const section = ddl.slice(start, end < 0 ? undefined : end);
  const re = /^  `[^`]+` AS (\w+)$/gm;
  const heads: Array<{alias: string; at: number}> = [];
  for (let m = re.exec(section); m; m = re.exec(section)) {
    heads.push({alias: m[1], at: m.index});
  }
  return heads.map(
      (h, i) => ({
        alias: h.alias,
        body: section.slice(
            h.at, i + 1 < heads.length ? heads[i + 1].at : undefined),
      }));
}

// The property name a PROPERTIES entry declares: the alias after the final
// top-level `AS` (ignoring a trailing OPTIONS(...) and any inner `CAST(x AS
// TYPE)`), else the leading bare column.
function declaredName(entry: string): string|undefined {
  const noOpts = entry.replace(/\s+OPTIONS\(.*\)\s*$/s, '').trim();
  const asMatch = noOpts.match(/ AS ([A-Za-z_]\w*)\s*$/);
  if (asMatch) return asMatch[1];
  const bare = noOpts.match(/^([A-Za-z_]\w*)\s*$/);
  return bare ? bare[1] : undefined;
}

describe(
    'every MEASURE operand is a property exposed by its own node (the exact rule live BigQuery enforces)',
    () => {
      // Reproduces BigQuery\'s DDL-time check -- rejecting a graph with
      // "Property <x> is not exposed by element type ..." -- so a lowering
      // regression that pointed a measure at a raw column or an un-exposed
      // operand is caught offline, without a live instance. Confirmed against a
      // real property graph: the fixtures below load and their measures
      // aggregate correctly via GRAPH_EXPAND + AGG().
      for (const fixture of CORPUS) {
        test(fixture, () => {
          const {ddl} = build(fixture);
          for (const {alias, body} of nodeBlocks(ddl)) {
            const propsMatch = body.match(/PROPERTIES\(([\s\S]*?)\n {4}\)/);
            if (!propsMatch) continue;
            // One entry per property line (indent 6), trailing comma stripped.
            const entries = propsMatch[1]
                                .split('\n')
                                .map(l => l.trim().replace(/,$/, ''))
                                .filter(Boolean);
            const exposed = new Set<string>();
            const measureOperands: string[] = [];
            for (const e of entries) {
              const meas = e.match(
                  /^MEASURE\(\s*\w+\(\s*(?:DISTINCT\s+)?([A-Za-z_]\w*)\)/);
              if (meas) {
                measureOperands.push(meas[1]);
                continue;  // a measure is exposed, but cannot be another\'s
                           // operand
              }
              const name = declaredName(e);
              if (name) exposed.add(name);
            }
            for (const operand of measureOperands) {
              // Encodes the node + operand so a failure names exactly which
              // measure points at an un-exposed property.
              expect(`${fixture} ${alias}: operand '${operand}' exposed=${
                         exposed.has(operand)}`)
                  .toBe(
                      `${fixture} ${alias}: operand '${operand}' exposed=true`);
            }
          }
        });
      }
    });


// A binding-profile pair is two files -- a logical model plus a profile that
// supplies the physical bindings -- so it does not fit the single-file CORPUS
// loop above. Each pair runs the same file -> merge -> prune -> IR -> DDL path
// push takes, against its own golden. Read a `<logical>.yaml` beside its
// `<logical>.<profile>.yaml` and their `.<profile>.bigquery.golden.sql` to see,
// end to end, what a given binding case emits.
//
// The corpus covers the distinct binding cases:
//   - profile_binding + analytical : a purely logical base (no inline bindings)
//     bound entirely by the profile, which renames every physical column and
//     leaves one field unbound.
//   - profile_binding + operational: the SAME logical base bound a second way --
//     one model, two physical realizations, a different field unbound in each.
//   - partial_binding + prod       : a combined single-file model (already fully
//     bound inline) whose profile re-declares every column over new tables and a
//     new deployment target (an environment swap); selecting it clears the inline
//     bindings, so the profile is authoritative.
//   - partial_binding + remap      : the same combined base, a profile that
//     re-declares its columns -- renaming one and omitting another, which leaves
//     that field unbound.
function buildProfile(logicalFixture: string, profile: string) {
  const dir = path.join(FIXTURES, 'profiles');
  const logicalText = fs.readFileSync(path.join(dir, logicalFixture), 'utf8');
  const profileText = fs.readFileSync(
      path.join(dir, logicalFixture.replace(/\.yaml$/, `.${profile}.yaml`)),
      'utf8');
  const merged =
      mergeProfile(yaml.parse(logicalText), yaml.parse(profileText), profile);
  if (merged.error) throw new Error(merged.error);
  const loaded = loadSemanticModels(
      [{name: logicalFixture.replace(/\.yaml$/, ''), text: yaml.stringify(merged.doc)}],
      {defaultProject: 'acme', defaultDataset: 'sales'});
  if (loaded.error) throw new Error(loaded.error);
  const {model, report} = pruneUnavailable(loaded.models[0].model, profile);
  // Derive the generation project/dataset from the model's own resolved
  // bindings, so the graph name and its tables share the one project.dataset the
  // chosen profile points at (each profile may target a different environment).
  const bound = (model.entities ?? []).find(
      e => /^[^.]+\.[^.]+\.[^.]+$/.test(e.dataSource ?? ''));
  const [project, dataset] =
      bound ? bound.dataSource!.split('.') : ['acme', 'sales'];
  const {ddl, warnings: genWarnings} =
      generatePropertyGraph(model, {project, dataset});
  return {model, report, ddl, loadWarnings: loaded.warnings, genWarnings};
}

// The golden for a merged profile: the DDL, then the availability report (what
// the binding withheld) and every warning, so a reviewer sees the pruned field
// and metric alongside the emitted physical columns.
function renderProfile(logicalFixture: string, profile: string): string {
  const {ddl, report, loadWarnings, genWarnings} =
      buildProfile(logicalFixture, profile);
  const lines: string[] = [];
  for (const d of report.droppedEntities) {
    lines.push(`dropped entity: ${d.name} (${d.reason})`);
  }
  for (const fld of report.unboundFields) lines.push(`unbound field: ${fld}`);
  for (const d of report.droppedMetrics) {
    lines.push(`dropped metric: ${d.name} (${d.reason})`);
  }
  for (const d of report.droppedRelationships) {
    lines.push(`dropped relationship: ${d.name} (${d.reason})`);
  }
  const reportBlock = lines.length ? lines.join('\n') : '(nothing withheld)';
  const warnings = [...loadWarnings, ...genWarnings];
  const warnBlock =
      warnings.length ? warnings.map(w => `-- ${w}`).join('\n') : '-- (none)';
  return `${ddl}\n-- availability --\n${reportBlock}\n-- warnings --\n${
      warnBlock}\n`;
}

const profileGoldenPath = (logicalFixture: string, profile: string) =>
    path.join(
        FIXTURES, 'profiles',
        logicalFixture.replace(/\.yaml$/, `.${profile}.bigquery.golden.sql`));

// Every logical/profile pair that gets a golden. New pairs are added here.
const PROFILE_CORPUS = [
  {logical: 'profile_binding.yaml', profile: 'analytical'},
  {logical: 'profile_binding.yaml', profile: 'operational'},
  {logical: 'partial_binding.yaml', profile: 'prod'},
  {logical: 'partial_binding.yaml', profile: 'remap'},
];


describe(
    'golden DDL: each logical model + binding profile generates its exact property graph',
    () => {
      for (const {logical, profile} of PROFILE_CORPUS) {
        test(`${logical} + ${profile}`, () => {
          const actual = renderProfile(logical, profile);
          const golden = profileGoldenPath(logical, profile);
          if (process.env.UPDATE_GOLDENS) {
            fs.writeFileSync(golden, actual);
            return;
          }
          if (!fs.existsSync(golden)) {
            throw new Error(`missing golden ${
                path.basename(golden)} -- run UPDATE_GOLDENS=1 to create it`);
          }
          expect(actual).toBe(fs.readFileSync(golden, 'utf8'));
        });
      }
    });


describe('binding profiles resolve physical columns and availability', () => {
  test('a renamed profile emits physical columns, never logical names', () => {
    const {ddl} = buildProfile('profile_binding.yaml', 'analytical');
    // Structural sites carry the bound physical column.
    expect(ddl).toContain('KEY(cust_id)');
    expect(ddl).toContain('KEY(order_id)');
    expect(ddl).toContain(
        'DESTINATION KEY(fk_customer) REFERENCES Customer(cust_id)');
    // A renamed column is exposed under its logical name (`gross_amount AS
    // amount`), and the MEASURE aggregates that exposed property -- the one
    // position where the logical name is correct, because it names a sibling
    // property, not a raw column. This is the shape live BigQuery accepts
    // (verified: `MEASURE(SUM(item_count))` over `num_of_item AS item_count`).
    expect(ddl).toContain('gross_amount AS amount');
    expect(ddl).toContain('MEASURE(SUM(amount)) AS total_amount');
    // No logical field name leaks into a structural (KEY/REFERENCES) position,
    // where BigQuery requires the physical column.
    expect(ddl).not.toContain('KEY(id)');
    expect(ddl).not.toContain('KEY(customerId)');
    expect(ddl).not.toContain('REFERENCES Customer(id)');
    expect(ddl).not.toContain('(customerId)');
  });

  test('an unbound field prunes it and the metric that reads it', () => {
    const {model, report} = buildProfile('profile_binding.yaml', 'analytical');
    const customer = model.entities.find(e => e.name === 'Customer')!;
    expect(customer.fields.map(f => f.name)).toEqual(['id', 'name']);
    expect((model.metrics ?? []).map(m => m.name).sort()).toEqual([
      'order_count', 'total_amount'
    ]);
    expect(report.unboundFields).toContain('Customer.segment');
    expect(report.droppedMetrics.some(d => d.name === 'segment_count'))
        .toBe(true);
  });

  test(
      'a second profile over the same model binds a different field, so it ' +
          'answers a different metric',
      () => {
        // operational binds `segment` and unbinds `amount`: the mirror image of
        // analytical. One logical model, two physical realizations.
        const {model, report} = buildProfile('profile_binding.yaml', 'operational');
        const names = (model.metrics ?? []).map(m => m.name).sort();
        expect(names).toEqual(['order_count', 'segment_count']);
        expect(report.unboundFields).toEqual(['Order.amount']);
        expect(report.droppedMetrics.map(d => d.name)).toEqual(['total_amount']);
      });

  test(
      'a profile that re-declares every column deploys the whole model over ' +
          'new tables (an environment swap)',
      () => {
        // prod re-declares every column -- the same names -- over the prod
        // tables and a new target. Nothing is unbound, so every metric survives.
        // Selecting the profile clears the base's inline bindings; the profile's
        // own bindings are what deploy.
        const {ddl, model, report} = buildProfile('partial_binding.yaml', 'prod');
        expect(report.unboundFields).toEqual([]);
        expect(report.droppedMetrics).toEqual([]);
        expect((model.metrics ?? []).map(m => m.name).sort()).toEqual([
          'order_count', 'total_amount', 'total_discount'
        ]);
        // The re-declared columns, emitted over the prod tables.
        expect(ddl).toContain('`acme-prod.sales.customers` AS Customer');
        expect(ddl).toContain('customer_name AS name');
        // A field whose column equals its logical name emits bare, no AS.
        expect(ddl).toContain('MEASURE(SUM(discount)) AS total_discount');
        expect(ddl).not.toContain('acme-dev');
      });

  test('a profile renames one column and omits another, unbinding it', () => {
    // remap re-declares its columns: Customer.name maps to a different column,
    // and Order.discount is omitted -- so it is unbound and total_discount prunes.
    const {ddl, report} = buildProfile('partial_binding.yaml', 'remap');
    expect(ddl).toContain('full_name AS name');   // remapped column
    expect(ddl).toContain('order_id AS id');       // re-declared
    expect(report.unboundFields).toEqual(['Order.discount']);
    expect(report.droppedMetrics.map(d => d.name)).toEqual(['total_discount']);
  });
});
