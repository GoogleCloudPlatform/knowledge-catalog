// Behavior specification for the data profile (`kcmd profile`, proposed;
// src/libts/semantic/profile_bigquery.ts): the model's claims planned as
// statements, one read-only query per statement, the query rows settled as
// verified / unverified / contradicted with evidence, the reports, the
// Knowledge Catalog aspect and the runner.
//
// The primary checks are GOLDEN tests over fixtures/data_profile/shop.yaml:
// the complete .sql file the plan renders and -- from the simulated rows in
// fixtures/data_profile/shop.results.yaml -- every statement's status and
// evidence (JSON) and the markdown report.
//
//   Regenerate goldens after an intentional change:
//     UPDATE_GOLDENS=1 node_modules/.bin/bun test ./tests/libts/semantic/profile_bigquery.test.ts
//   then read the diff before committing.
//
// The focused tests below the goldens cover what a golden cannot make
// self-evident: each status boundary, the time-field and `Regime:` rules, the
// options, failed queries, and the publish and run paths (with the API
// clients stubbed, so nothing is sent).

import {describe, expect, spyOn, test} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as yaml from 'yaml';

import * as bq from '../../../src/libts/gcp/bigquery';
import {ApiContext} from '../../../src/libts/gcp/context';
import {CatalogClient} from '../../../src/libts/gcp/dataplex';
import {DataType, Entity, Field, SemanticModel} from '../../../src/libts/semantic/ir';
import {loadModels} from '../../../src/libts/semantic/loader';
import {
  chooseTimeField,
  countStatuses,
  declaredRegime,
  distinctQueries,
  evaluateProfile,
  firstRow,
  formatProfileTable,
  parseJobLabels,
  parseProfileOptions,
  planBigQueryProfile,
  PROFILE_DEFAULTS,
  PROFILE_RESULTS_ASPECT_TYPE,
  profileAspectKey,
  profileAspectTypeName,
  ProfileFinding,
  ProfilePlan,
  ProfilePlanOptions,
  profileReport,
  profileResultsUpdates,
  publishProfileResults,
  QueryOutcome,
  QueryRow,
  regimeNote,
  renderProfileMarkdown,
  renderProfileSql,
  runBigQueryProfile,
  windowLabel,
} from '../../../src/libts/semantic/profile_bigquery';
import {entityEntryName} from '../../../src/libts/semantic/validate_bigquery';

const FIXTURES = path.join(__dirname, 'fixtures', 'data_profile');
const UPDATE = !!process.env.UPDATE_GOLDENS;
const CTX = new ApiContext('test-project', 'us', 'test-token');
const DEST = {project: 'dest-proj', location: 'us', entryGroup: 'eg'};
const META = {model: 'shop', profile: 'default', checkedAt: '2026-01-01T00:00:00.000Z'};

// Loads a fixture the way `kcmd profile` loads a scope: bindings optional, so
// an entity with no table loads (and is reported as not profiled).
function loadFixture(file: string): SemanticModel {
  const text = fs.readFileSync(path.join(FIXTURES, file), 'utf8');
  return loadModels(text, {
           defaultProject: 'sqlgen-testing',
           defaultDataset: 'demo',
           bindingOptional: true,
         }).models[0];
}

// The rows of a `<fixture>.results.yaml` as outcomes keyed by SQL text: each
// row is filed under the id of the first statement its query settles.
function simulatedOutcomes(plan: ProfilePlan, file: string): Map<string, QueryOutcome> {
  const rows =
      yaml.parse(fs.readFileSync(path.join(FIXTURES, file), 'utf8')) as Record<string, QueryRow>;
  const outcomes = new Map<string, QueryOutcome>();
  for (const [id, row] of Object.entries(rows)) {
    const check = plan.checks.find(c => c.id === id);
    if (!check) throw new Error(`${file}: the plan has no statement '${id}'`);
    outcomes.set(check.sql, {row});
  }
  return outcomes;
}

function golden(file: string, actual: string): void {
  const p = path.join(FIXTURES, file);
  if (UPDATE) {
    fs.writeFileSync(p, actual);
    return;
  }
  if (!fs.existsSync(p)) {
    throw new Error(`missing golden ${file} -- run UPDATE_GOLDENS=1 to create it`);
  }
  expect(actual).toBe(fs.readFileSync(p, 'utf8'));
}

function shopPlan(options: ProfilePlanOptions = {}): ProfilePlan {
  return planBigQueryProfile(loadFixture('shop.yaml'), options);
}

function shopFindings(plan = shopPlan()): ProfileFinding[] {
  return evaluateProfile(plan, simulatedOutcomes(plan, 'shop.results.yaml'));
}

// The finding for statement `id` when its query returns `row` (every other
// query left unrun).
function settle(plan: ProfilePlan, id: string, row: QueryRow): ProfileFinding {
  const sql = plan.checks.find(c => c.id === id)!.sql;
  return evaluateProfile(plan, new Map([[sql, {row}]])).find(f => f.id === id)!;
}

const byId = (findings: ProfileFinding[], id: string) => findings.find(f => f.id === id)!;

// Inline IR: a bound field, a one-table entity keyed on its first field.
function f(name: string, type?: DataType, extra: Partial<Field> = {}): Field {
  return {name, expression: name, ...(type ? {type} : {}), ...extra};
}
function table(name: string, fields: Field[], extra: Partial<Entity> = {}): Entity {
  return {
    name,
    dataSource: `p.d.${name.toLowerCase()}`,
    keys: [fields[0].name],
    fields,
    ...extra,
  };
}
function model(entities: Entity[], extra: Partial<SemanticModel> = {}): SemanticModel {
  return {name: 'm', entities, relationships: [], metrics: [], ...extra};
}


describe('golden: data_profile/shop.yaml', () => {
  const plan = shopPlan();
  const findings = shopFindings(plan);

  test('every query has exactly one simulated row', () => {
    const outcomes = simulatedOutcomes(plan, 'shop.results.yaml');
    expect([...outcomes.keys()].sort()).toEqual(distinctQueries(plan).sort());
  });

  test('the .sql file', () => {
    golden('shop.profile.golden.sql', renderProfileSql(plan, {profile: 'default'}));
  });

  test('statuses and evidence', () => {
    const statements = findings.map(({sql: _sql, ...rest}) => rest);
    golden('shop.profile.golden.json', JSON.stringify(statements, null, 2) + '\n');
  });

  test('profile.md', () => {
    golden('shop.profile.golden.md',
           renderProfileMarkdown([profileReport(plan, findings, META)]));
  });

  test('each statement settles for the reason the fixture documents', () => {
    expect(Object.fromEntries(findings.map(x => [x.id, x.status]))).toEqual({
      Customer_primary_key: 'verified',
      Customer_unique_email: 'contradicted',  // 8 rows repeat an email
      Order_primary_key: 'verified',
      Invoice_primary_key: 'verified',
      placedBy_cardinality: 'verified',
      placedBy_orphans: 'contradicted',  // 14 orders name no customer
      billedFor_cardinality: 'contradicted',  // one-to-one; revisions repeat it
      billedFor_orphans: 'verified',
      Customer_segment_in: 'contradicted',  // 'Retail', 'corporate'
      Customer_credit_limit_unit: 'verified',
      Order_total_unit: 'verified',
      Order_discount_unit: 'unverified',  // alone in USD (x0.01)
      Invoice_amount_unit: 'verified',
      Invoice_tax_unit: 'unverified',  // 3 orders below its peers
      Customer_credit_limit_regime: 'verified',
      Order_total_regime: 'verified',  // the break is the declared regime
      Order_discount_regime: 'unverified',  // too few rows per window
      Order_quantity_regime: 'verified',
      Invoice_amount_regime: 'contradicted',  // undeclared x98 break
      Invoice_tax_regime: 'verified',
      VipCustomer_email_required: 'verified',
      Order_status_required: 'verified',
      Order_order_date_some: 'contradicted',  // 7 nulls
    });
  });
});


describe('planning', () => {
  test('statements come in a fixed order and claims with no query are listed', () => {
    const plan = shopPlan();
    expect([...new Set(plan.checks.map(c => c.kind))]).toEqual([
      'primaryKey', 'uniqueKey', 'cardinality', 'orphans', 'enumCoverage', 'unitMagnitude',
      'regimeShift', 'requiredNulls',
    ]);
    expect(plan.skipped.map(s => s.subject)).toEqual([
      'Supplier key supplier_id',
      'relationship suppliedBy',
      'Order.shipping_cost unit',
      'constraint Order_shipping_cost_required',
    ]);
    // A pattern and a judged rule are validate's to count: no statement.
    expect(plan.checks.some(c => c.constraint === 'Customer_email_pattern')).toBe(false);
    expect(plan.checks.some(c => c.constraint === 'Order_total_reviewed')).toBe(false);
  });

  test('statements sharing a table share one query', () => {
    const plan = shopPlan();
    const sqlOf = (id: string) => plan.checks.find(c => c.id === id)!.sql;
    expect(sqlOf('placedBy_orphans')).toBe(sqlOf('placedBy_cardinality'));
    expect(sqlOf('Order_discount_unit')).toBe(sqlOf('Order_total_unit'));
    expect(sqlOf('Order_quantity_regime')).toBe(sqlOf('Order_total_regime'));
    expect(sqlOf('Order_order_date_some')).toBe(sqlOf('Order_status_required'));
    expect(distinctQueries(plan).length).toBe(15);
  });

  test('a required rule on a defined entity reads only its members', () => {
    const sql = shopPlan().checks.find(c => c.id === 'VipCustomer_email_required')!.sql;
    expect(sql).toContain('WHERE (COALESCE(credit_limit >= 10000, FALSE))');
  });

  describe('relationship cardinality', () => {
    const shop = (constraint: string) => model(
        [
          table('Customer', [f('customer_id', 'String')]),
          table('KeyCustomer', [f('customer_id', 'String')], {extends: ['Customer']}),
          table('Order', [f('order_id', 'String'), f('customer_id', 'String')]),
        ],
        {
          relationships: [{
            name: 'placedBy',
            source: {entity: 'Order', columns: ['customer_id']},
            destination: {entity: 'Customer', columns: ['customer_id']},
            inverse: 'places',
          }],
          constraints: [{
            name: 'c',
            judgment: 'A generated judgment.',
            description: `Generated. (From OWL: ${constraint}.)`,
          }],
        });
    const cardinality = (constraint: string) =>
        planBigQueryProfile(shop(constraint)).checks.find(c => c.kind === 'cardinality')!;

    test('an inverse max 1 on the destination makes the edge one-to-one', () => {
      const c = cardinality('Customer SubClassOf places max 1 Order');
      expect(c).toMatchObject({declared: 'one-to-one', origin: 'OWL', constraint: 'c'});
    });

    test('an inverse max 1 on a subtype of the destination claims less', () => {
      const c = cardinality('KeyCustomer SubClassOf places max 1 Order');
      expect(c).toMatchObject({declared: 'many-to-one', origin: 'model'});
      expect(c.constraint).toBeUndefined();
    });

    test('a forward max 1 restates the many-to-one and is named as its origin', () => {
      const c = cardinality('placedBy is a FunctionalProperty');
      expect(c).toMatchObject({declared: 'many-to-one', origin: 'OWL', constraint: 'c'});
    });

    test('an association table is listed as not profiled; an abstract edge is left to its children', () => {
      const plan = planBigQueryProfile(model(
          [
            table('Student', [f('student_id', 'String')]),
            table('Course', [f('course_id', 'String')]),
          ],
          {
            relationships: [
              {
                name: 'relatedTo',
                source: {entity: 'Student', columns: []},
                destination: {entity: 'Course', columns: []},
                abstract: true,
              },
              {
                name: 'enrolledIn',
                source: {entity: 'Student', columns: ['student_id']},
                destination: {entity: 'Course', columns: ['course_id']},
                extends: ['relatedTo'],
                association: {
                  dataSource: 'p.d.enrollment',
                  keys: ['student_id', 'course_id'],
                  sourceColumns: ['student_id'],
                  destinationColumns: ['course_id'],
                },
              },
            ],
          }));
      expect(plan.checks.filter(c => c.kind === 'cardinality' || c.kind === 'orphans')).toEqual([]);
      expect(plan.skipped).toEqual([{
        subject: 'relationship enrolledIn',
        reason: 'relationship \'enrolledIn\' is backed by an association table; not profiled yet',
      }]);
    });
  });

  test('a subtype stored in its parent\'s table states the parent\'s key once', () => {
    const plan = planBigQueryProfile(model([
      table('Party', [f('party_id', 'String'), f('kind', 'String')]),
      {name: 'Person', dataSource: 'p.d.party', keys: ['party_id'], extends: ['Party'], fields: []},
    ]));
    expect(plan.checks.filter(c => c.kind === 'primaryKey').map(c => c.id))
        .toEqual(['Party_primary_key']);
  });

  test('a unit is measured on numeric and untyped fields only', () => {
    const plan = planBigQueryProfile(model([table('Parcel', [
      f('parcel_id', 'String'),
      f('weight', undefined, {unit: 'kg'}),
      f('weight_label', 'String', {unit: 'kg'}),
      f('volume', 'Float', {unit: 'l', scale: 1000}),
    ])]));
    const units = plan.checks.filter(c => c.kind === 'unitMagnitude');
    expect(units.map(c => c.field)).toEqual(['weight', 'volume']);
    expect(units[1].statement).toBe('Parcel.volume is in l (x1000).');
  });

  test('keys, unique keys and join columns are identifiers, not measures', () => {
    const plan = planBigQueryProfile(model(
        [
          table('Store', [f('store_no', 'Integer')]),
          table('Sale', [
            f('sale_no', 'Integer'),
            f('till_no', 'Integer'),
            f('store_no', 'Integer'),
            f('units', 'Integer'),
            f('sold_on', 'Date'),
          ], {uniqueKeys: [['till_no']]}),
        ],
        {
          relationships: [{
            name: 'soldAt',
            source: {entity: 'Sale', columns: ['store_no']},
            destination: {entity: 'Store', columns: ['store_no']},
          }],
        }));
    expect(plan.checks.filter(c => c.kind === 'regimeShift').map(c => c.field)).toEqual(['units']);
  });

  test('an entity with no usable date field states no regime', () => {
    const plan = planBigQueryProfile(model([table('Reading', [
      f('reading_id', 'String'),
      f('value', 'Float'),
      f('logged_on', 'Date', {dimension: {isTime: false}}),
      f('logged_at', 'Time'),
    ])]));
    expect(plan.checks.some(c => c.kind === 'regimeShift')).toBe(false);
  });

  test('options: no examples drops the top-N queries; the window sets the bucket', () => {
    const lean = shopPlan({examples: 0, windowMonths: 1});
    expect(lean.options).toEqual({...PROFILE_DEFAULTS, examples: 0, windowMonths: 1});
    const sql = distinctQueries(lean).join('\n');
    expect(sql).not.toContain('top_');
    expect(sql).toContain('EXTRACT(MONTH FROM kcmd_time) - 1, 1) AS kcmd_window');
  });

  // BigQuery rejects a query whose expression subquery (`x IN (SELECT ...)`,
  // `EXISTS (...)`, a scalar or ARRAY subquery) reads a bound view that
  // computes a field with its own correlated lookup -- a code matched against
  // a vocabulary table, say: the view cannot be de-correlated there. So every
  // query reads rows only as a CTE, a derived table or a join.
  test('queries read rows only in FROM clauses: no expression subquery', () => {
    for (const plan of [shopPlan(), shopPlan({examples: 0})]) {
      for (const sql of distinctQueries(plan)) {
        const opener = [...sql.matchAll(/(\S+)\s*\(\s*SELECT\b/g)].map(m => m[1].toUpperCase());
        expect(opener.filter(t => !['AS', 'FROM', 'JOIN'].includes(t))).toEqual([]);
      }
    }
    // The declared values that occur are collected in the one scan, against
    // the declared values inlined as literals.
    const sql = shopPlan().checks.find(c => c.id === 'Customer_segment_in')!.sql;
    expect(sql).toContain(
        'TO_JSON_STRING(ARRAY_AGG(DISTINCT IF(CAST(`segment` AS STRING) IN (\'retail\', ' +
        '\'wholesale\', \'online\'), CAST(`segment` AS STRING), NULL) IGNORE NULLS)) AS used_values');
  });
});


describe('chooseTimeField', () => {
  const bound = () => true;
  const event = (fields: Field[], extra: Partial<Entity> = {}) =>
      table('Event', [f('event_id', 'String'), ...fields], extra);
  const dates = [f('a', 'Date'), f('b', 'Date', {dimension: {isTime: true}}), f('c', 'DateTime')];

  test('history.valid_from first', () => {
    const e = event(dates, {grain: 'one row per event, by a', history: {versioned: true, validFrom: 'c'}});
    expect(chooseTimeField(e, bound)).toMatchObject({field: {name: 'c'}, from: 'history.valid_from'});
  });

  test('then the date field the grain names', () => {
    const e = event(dates, {grain: 'one row per event and day of c'});
    expect(chooseTimeField(e, bound)).toMatchObject({field: {name: 'c'}, from: 'grain'});
  });

  test('then a field marked dimension.is_time', () => {
    expect(chooseTimeField(event(dates), bound))
        .toMatchObject({field: {name: 'b'}, from: 'dimension.is_time'});
  });

  test('then the first date field; is_time false and unbound fields never count', () => {
    const e = event([
      f('a', 'Date', {dimension: {isTime: false}}),
      f('b', 'Date'),
      f('c', 'DateTimeTz'),
    ]);
    expect(chooseTimeField(e, x => x.name !== 'b'))
        .toMatchObject({field: {name: 'c'}, from: 'first date field'});
    expect(chooseTimeField(event([f('n', 'Integer')]), bound)).toBeUndefined();
  });

  test('an untyped field counts when it is marked is_time', () => {
    const e = event([f('n', 'Integer'), f('d', undefined, {dimension: {isTime: true}})]);
    expect(chooseTimeField(e, bound))
        .toMatchObject({field: {name: 'd'}, from: 'dimension.is_time'});
  });
});


describe('the Regime: note (proposed)', () => {
  test('the first `Regime:` line of any text, case-insensitive', () => {
    expect(regimeNote('Order total.\n  regime :  cents before 2021. ')).toBe('cents before 2021.');
    expect(regimeNote(undefined, 'No note.', 'Regime: x\nRegime: y')).toBe('x');
    expect(regimeNote('A regime: in passing is not a note.')).toBeUndefined();
  });

  test('a field\'s own note, else its entity\'s for the fields that note names', () => {
    const e = table('Meter', [
      f('meter_id', 'String'),
      f('kwh', 'Float', {description: 'Regime: Wh until 2022.'}),
      f('volts', 'Float'),
      f('amps', 'Float', {aiContext: {instructions: 'Regime: mA since 2023.'}}),
      f('ohms', 'Float'),
    ], {description: 'A meter.\nRegime: volts recalibrated in 2021.'});
    const regime = (name: string) => declaredRegime(e, e.fields.find(x => x.name === name)!);
    expect(regime('kwh')).toBe('Wh until 2022.');
    expect(regime('amps')).toBe('mA since 2023.');
    expect(regime('volts')).toBe('volts recalibrated in 2021.');
    expect(regime('ohms')).toBeUndefined();
    // An entity note that names no field covers them all.
    const all = {...e, description: 'Regime: every reading x10 since 2020.'};
    expect(declaredRegime(all, e.fields[4])).toBe('every reading x10 since 2020.');
  });
});


describe('evaluation', () => {
  const plan = shopPlan();

  test('keys: no rows, a null primary key, a unique key with nulls', () => {
    expect(settle(plan, 'Order_primary_key',
                  {total: '0', null_keys: '0', distinct_keys: '0', top_repeated: null}))
        .toMatchObject({status: 'unverified', summary: 'the table has no rows'});
    expect(settle(plan, 'Order_primary_key',
                  {total: '10', null_keys: '2', distinct_keys: '8', top_repeated: null}))
        .toMatchObject({
          status: 'contradicted',
          summary: '2 of 10 row(s) (20%) have a null key',
          evidence: {duplicateRows: 0},
        });
    expect(settle(plan, 'Customer_unique_email',
                  {total: '5', null_keys: '5', distinct_keys: '0', top_repeated: null}).status)
        .toBe('unverified');
    expect(settle(plan, 'Customer_unique_email',
                  {total: '5', null_keys: '2', distinct_keys: '3', top_repeated: null}))
        .toMatchObject({
          status: 'verified',
          summary: '5 row(s), 3 distinct key(s) (2 row(s) with a null column not compared)',
        });
  });

  test('cardinality: a foreign key reaching several rows contradicts many-to-one', () => {
    const row = {
      total: '10', fk_rows: '8', orphan_rows: '0', orphan_values: '0', fanout_rows: '2',
      max_targets: '3', max_sources: '1', top_orphans: null,
    };
    expect(settle(plan, 'placedBy_cardinality', row)).toMatchObject({
      status: 'contradicted',
      evidence: {declared: 'many-to-one', observed: 'one-to-many', maxTargetsPerRow: 3},
    });
    expect(settle(plan, 'placedBy_cardinality', {...row, fk_rows: '0', fanout_rows: '0'}).status)
        .toBe('unverified');
    expect(settle(plan, 'placedBy_orphans', row))
        .toMatchObject({status: 'verified', summary: 'all 8 foreign-key value(s) match a row of Customer'});
  });

  test('value sets: nothing set is unverified; unused declared values are listed', () => {
    const row = {
      total: '4', non_null: '0', outside_rows: '0', outside_values: '0',
      used_values: 'null', top_outside: null,
    };
    expect(settle(plan, 'Customer_segment_in', row)).toMatchObject({
      status: 'unverified',
      evidence: {unusedValues: ['retail', 'wholesale', 'online'], unusedCount: 3},
    });
    expect(settle(plan, 'Customer_segment_in',
                  {...row, non_null: '4', used_values: '["wholesale","retail"]'}))
        .toMatchObject({
          status: 'verified',
          summary: 'all 4 value(s) are in the declared set; 1 declared value(s) never occur',
          evidence: {unusedValues: ['online'], unusedCount: 1},
        });
  });

  test('units: a field with no non-zero value is unverified and nobody\'s peer', () => {
    const outcomes = simulatedOutcomes(plan, 'shop.results.yaml');
    const customer = plan.checks.find(c => c.id === 'Customer_credit_limit_unit')!.sql;
    outcomes.set(customer, {row: {total: '3', values_0: '0', median_0: null}});
    const findings = evaluateProfile(plan, outcomes);
    expect(byId(findings, 'Customer_credit_limit_unit'))
        .toMatchObject({status: 'unverified', summary: 'no non-zero value to measure'});
    expect(byId(findings, 'Order_total_unit').evidence.peerFields)
        .toEqual(['Invoice.amount', 'Invoice.tax']);
  });

  test('regimes: the shift factor and the rows a window needs are options', () => {
    const tolerant = shopFindings(shopPlan({shiftFactor: 200}));
    expect(byId(tolerant, 'Invoice_amount_regime').status).toBe('verified');
    const sparse = shopFindings(shopPlan({minWindowRows: 10}));
    expect(byId(sparse, 'Order_discount_regime'))
        .toMatchObject({status: 'verified', evidence: {windows: 5}});
  });

  test('required fields: no rows is unverified', () => {
    expect(settle(plan, 'VipCustomer_email_required', {total: '0', nulls_0: '0'}))
        .toMatchObject({status: 'unverified', summary: 'no VipCustomer rows'});
  });

  test('a failed query leaves every statement it settles unverified, with the error', () => {
    const sql = plan.checks.find(c => c.id === 'placedBy_cardinality')!.sql;
    const findings = evaluateProfile(plan, new Map([[sql, {error: 'Access Denied: shop.orders\nmore'}]]));
    for (const id of ['placedBy_cardinality', 'placedBy_orphans']) {
      expect(byId(findings, id)).toMatchObject({
        status: 'unverified',
        summary: 'the query failed: Access Denied: shop.orders',
        error: 'Access Denied: shop.orders\nmore',
      });
    }
    expect(byId(findings, 'Order_primary_key')).toMatchObject({status: 'unverified', summary: 'not run'});
  });

  test('a row missing a column is an unreadable result, not a crash', () => {
    expect(settle(plan, 'Order_primary_key', {total: '1'})).toMatchObject({
      status: 'unverified',
      summary: 'unreadable result: the result has no column \'null_keys\'',
    });
  });

  test('windows are labelled by their first month', () => {
    expect(windowLabel(8080, 3)).toBe('2020-01');
    expect(windowLabel(8083, 3)).toBe('2020-10');
    expect(windowLabel(24241, 1)).toBe('2020-02');
  });
});


describe('reports', () => {
  const findings = shopFindings();

  test('the console table lists the worst first and ends with the totals', () => {
    const lines = formatProfileTable(findings).split('\n');
    expect(lines[0]).toMatch(/^STATUS\s+KIND\s+SUBJECT\s+SUMMARY$/);
    expect(lines[1]).toMatch(/^contradicted\s+uniqueKey\s+Customer\(email\)\s+8 row\(s\)/);
    expect(lines[lines.length - 1])
        .toBe('23 statement(s): 14 verified, 3 unverified, 6 contradicted');
    expect(countStatuses(findings)).toEqual({verified: 14, unverified: 3, contradicted: 6});
  });

  test('the JSON report carries the options, the skipped claims and the SQL', () => {
    const report = profileReport(shopPlan(), findings, META);
    expect(report).toMatchObject({model: 'shop', profile: 'default', options: PROFILE_DEFAULTS});
    expect(report.skipped.length).toBe(4);
    expect(report.statements[0].sql).toContain('COUNT(DISTINCT');
  });
});


describe('the Knowledge Catalog aspect', () => {
  const findings = shopFindings();
  const key = 'dest-proj.global.semantic-profile-results';

  test('one update per entity, carrying only the profile aspect', () => {
    const updates = profileResultsUpdates(findings, DEST, META);
    expect(updates.map(u => u.name))
        .toEqual(['Customer', 'Order', 'Invoice', 'VipCustomer'].map(
            e => entityEntryName(DEST, 'shop', e)));
    expect(profileAspectKey(DEST)).toBe(key);
    const order = updates[1];
    expect(Object.keys(order.aspects!)).toEqual([key]);
    const aspect = order.aspects![key];
    expect(aspect.aspectType).toBe(profileAspectTypeName(DEST));
    const data = aspect.data!;
    expect(data).toMatchObject({model: 'shop', verified: 6, unverified: 2, contradicted: 2});
    const statement = data.statements.find((s: any) => s.id === 'placedBy_orphans');
    expect(statement).toMatchObject({kind: 'orphans', status: 'contradicted', field: 'placedBy'});
    expect(JSON.parse(statement.evidence)).toMatchObject({orphanRows: 14, fkRows: 4990});
    expect(statement.sql).toContain('LEFT JOIN dst');
    expect(data.sqlOmitted).toBeUndefined();
  });

  test('past the size budget the queries are left out', () => {
    const big = findings.map(x => ({...x, sql: `${x.sql}\n-- ${'x'.repeat(10_000)}`}));
    const data = profileResultsUpdates(big, DEST, META)[1].aspects![key].data!;
    expect(data.sqlOmitted).toBe(true);
    expect(data.statements.every((s: any) => s.sql === undefined)).toBe(true);
  });

  test('the aspect type template numbers every field once', () => {
    type TemplateField = {name: string; index: number; arrayItems?: {recordFields?: TemplateField[]}};
    const top: TemplateField[] = PROFILE_RESULTS_ASPECT_TYPE.metadataTemplate.recordFields;
    const inner = top.find(x => x.name === 'statements')!.arrayItems!.recordFields!;
    for (const fields of [top, inner]) {
      expect(new Set(fields.map(x => x.index)).size).toBe(fields.length);
    }
  });

  test('a dry run prints the requests and sends nothing', async () => {
    const create = spyOn(CatalogClient.prototype, 'createAspectType');
    const update = spyOn(CatalogClient.prototype, 'updateEntry');
    try {
      const lines: string[] = [];
      const res = await publishProfileResults(
          findings, CTX, DEST, META, {dryRun: true, log: l => lines.push(l)});
      expect(create).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(res.published).toEqual([]);
      expect(res.planned.length).toBe(4);
      expect(lines[0]).toStartWith(
          'POST projects/dest-proj/locations/global/aspectTypes?aspectTypeId=semantic-profile-results');
      expect(lines).toContain(`PATCH ${entityEntryName(DEST, 'shop', 'Order')}?updateMask=aspects&aspectKeys=${key}`);
    } finally {
      create.mockRestore();
      update.mockRestore();
    }
  });

  test('publishing names only the profile aspect, and reports a missing entry', async () => {
    const create = spyOn(CatalogClient.prototype, 'createAspectType')
                       .mockImplementation(async () => ({status: 409}));
    const update = spyOn(CatalogClient.prototype, 'updateEntry')
                       .mockImplementation(async (entry: any) =>
                           ({status: entry.name.endsWith('VipCustomer') ? 404 : 200}));
    try {
      const res = await publishProfileResults(findings, CTX, DEST, META);
      expect(update).toHaveBeenCalledTimes(4);
      for (const call of update.mock.calls) expect(call.slice(1)).toEqual([['aspects'], [key]]);
      expect(res.published.length).toBe(3);
      expect(res.errors).toEqual(['shop.entities.VipCustomer: no such entry (run `kcmd push` first)']);
    } finally {
      create.mockRestore();
      update.mockRestore();
    }
  });
});


describe('running', () => {
  const plan = planBigQueryProfile(model([table('Item', [f('item_id', 'String')])]));
  const ok = (cells: Record<string, string|null>) => ({
    status: 200,
    result: {
      jobComplete: true,
      schema: {fields: Object.keys(cells).map(name => ({name}))},
      rows: [{f: Object.values(cells).map(v => ({v}))}],
    },
  });

  test('each query runs once, labelled, and its row is read by column name', async () => {
    const query = spyOn(bq.BigQueryClient.prototype, 'query')
                      .mockImplementation(async () => ok({total: '2', null_keys: '0'}));
    try {
      const outcomes = await runBigQueryProfile(
          plan, CTX, {project: 'jobs-proj', location: 'EU', labels: {team: 'data'}});
      expect(query).toHaveBeenCalledTimes(distinctQueries(plan).length);
      const [project, , location, dryRun, , labels] = query.mock.calls[0];
      expect([project, location, dryRun, labels]).toEqual(['jobs-proj', 'EU', false, {team: 'data'}]);
      expect(outcomes.get(plan.checks[0].sql)).toEqual({row: {total: '2', null_keys: '0'}});
    } finally {
      query.mockRestore();
    }
  });

  test('an unfinished job is polled; a rejected one is an error', async () => {
    const query = spyOn(bq.BigQueryClient.prototype, 'query')
                      .mockImplementation(async () => ({
                        status: 200,
                        result: {jobComplete: false, jobReference: {jobId: 'j1', location: 'US'}},
                      }));
    const poll = spyOn(bq.BigQueryClient.prototype, 'getQueryResults')
                     .mockImplementation(async () => ok({total: '1'}));
    try {
      const outcomes = await runBigQueryProfile(plan, CTX);
      expect(poll.mock.calls[0].slice(0, 3)).toEqual(['test-project', 'j1', 'US']);
      expect(outcomes.get(plan.checks[0].sql)).toEqual({row: {total: '1'}});
      query.mockImplementation(async () => ({
                                 status: 400,
                                 message: JSON.stringify({error: {message: 'Syntax error'}}),
                               }));
      const failed = await runBigQueryProfile(plan, CTX);
      expect(failed.get(plan.checks[0].sql)).toEqual({error: 'Syntax error'});
    } finally {
      query.mockRestore();
      poll.mockRestore();
    }
  });

  test('firstRow maps cells to column names', () => {
    expect(firstRow({schema: {fields: [{name: 'a'}, {name: 'b'}]}, rows: [{f: [{v: '1'}, {v: null}]}]}))
        .toEqual({a: '1', b: null});
    expect(firstRow({schema: {fields: [{name: 'a'}]}, rows: []})).toBeUndefined();
  });

  test('job labels are key:value pairs in BigQuery\'s label alphabet', () => {
    expect(parseJobLabels(['team:data', 'env:dev'])).toEqual({labels: {team: 'data', env: 'dev'}});
    expect(parseJobLabels('owner:')).toEqual({labels: {owner: ''}});
    expect(parseJobLabels('error:none')).toEqual({labels: {error: 'none'}});
    expect(parseJobLabels(undefined)).toEqual({labels: {}});
    expect(parseJobLabels('Team:data')).toHaveProperty('error');
    expect(parseJobLabels(['team'])).toHaveProperty('error');
    expect(parseJobLabels('team:Data Ops')).toHaveProperty('error');
  });
});


describe('tuning flags', () => {
  test('values arrive as strings or numbers; absent ones keep their default', () => {
    expect(parseProfileOptions({})).toEqual({});
    expect(parseProfileOptions({examples: '0', windowMonths: 1, shiftFactor: '10.5', magnitudeOrders: '1.5'}))
        .toEqual({examples: 0, windowMonths: 1, shiftFactor: 10.5, magnitudeOrders: 1.5});
    expect(shopPlan(parseProfileOptions({minWindowRows: '5'}) as ProfilePlanOptions).options)
        .toEqual({...PROFILE_DEFAULTS, minWindowRows: 5});
  });

  test('a value out of range names its flag and rule', () => {
    expect(parseProfileOptions({examples: '-1'}))
        .toEqual({error: '--examples must be a whole number >= 0; got \'-1\''});
    expect(parseProfileOptions({windowMonths: '1.5'})).toHaveProperty('error');
    expect(parseProfileOptions({shiftFactor: '1'})).toHaveProperty('error');
    expect(parseProfileOptions({magnitudeOrders: 'x'})).toHaveProperty('error');
    expect(parseProfileOptions({minWindowRows: ' '})).toHaveProperty('error');
  });
});
