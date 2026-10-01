import {describe, expect, test} from 'bun:test';

import {Constraint, Entity, SemanticModel} from '../../../src/libts/semantic/ir';
import {generateCatalogResources} from '../../../src/libts/semantic/knowledge_catalog';
import {
  checkResult,
  CONSTRAINT_RESULTS_ASPECT_TYPE,
  constraintResultPayload,
  constraintResultsUpdates,
  entityEntryName,
  formatResultsTable,
  parseConstraintSpec,
  planBigQueryValidation,
  renderValidationSql,
  resultsAspectKey,
  unsupportedWarning,
  validationManifest,
  ValidationCheck,
} from '../../../src/libts/semantic/validate_bigquery';

// A bound field: logical name -> physical column.
function f(name: string, column: string|undefined, type?: any) {
  return {
    name,
    ...(column !== undefined ? {expression: column} : {}),
    ...(type ? {type} : {}),
  };
}

const OPPORTUNITY: Entity = {
  name: 'Opportunity',
  dataSource: 'p.d.opportunity',
  keys: ['opportunity_id'],
  fields: [
    f('opportunity_id', 'opportunity_id'),
    f('name', 'opp_name', 'String'),
    f('stage', 'stage', 'String'),
    f('amount', 'amount', 'Decimal'),
    f('start_date', 'start_date', 'Date'),
    f('close_date', 'close_date', 'Date'),
    f('account_id', 'account_id'),
    // Unbound under this binding: no column.
    f('probability', undefined, 'Decimal'),
  ],
};
const ACCOUNT: Entity = {
  name: 'Account',
  dataSource: 'p.d.account',
  keys: ['account_id'],
  fields: [f('account_id', 'account_id'), f('region', 'region', 'String')],
};
const PARTNER: Entity = {
  name: 'Partner',
  dataSource: 'p.d.partner',
  keys: ['account_id'],
  fields: [f('account_id', 'account_id')],
};

function model(constraints: Constraint[]): SemanticModel {
  return {
    name: 'sales',
    entities: [OPPORTUNITY, ACCOUNT, PARTNER],
    relationships: [{
      name: 'hasBuyer',
      source: {entity: 'Opportunity', columns: ['account_id']},
      destination: {entity: 'Account', columns: ['account_id']},
      inverse: 'hasOpportunity',
    }],
    metrics: [],
    constraints,
  };
}

function shacl(name: string, path: string, terms: string, judgment?: string): Constraint {
  return {
    name,
    ...(judgment ? {judgment} : {judgment: 'A generated judgment.'}),
    description: `Generated. (From SHACL: Shape, ${path} ${terms}.)`,
  } as Constraint;
}
function owl(name: string, axiom: string): Constraint {
  return {
    name,
    judgment: 'A generated judgment.',
    description: `Generated. (From OWL: ${axiom}.)`,
  } as Constraint;
}

// The one check a single-constraint model plans (structural checks off).
function only(c: Constraint): ValidationCheck {
  const plan = planBigQueryValidation(model([c]), {structural: false});
  expect(plan.unsupported).toEqual([]);
  expect(plan.checks.length).toBe(1);
  return plan.checks[0];
}

const OPP_FOCUS = (cols: string) =>
    `WITH focus AS (\n  SELECT ${cols}\n  FROM \`p.d.opportunity\`\n)\n`;

describe('validate_bigquery: SQL per constraint kind', () => {
  test('required (SHACL minCount 1): full golden count + examples', () => {
    const c = only(shacl('Opportunity_name_required', 'name', 'sh:minCount 1'));
    expect(c.kind).toBe('required');
    expect(c.entity).toBe('Opportunity');
    expect(c.field).toBe('name');
    expect(c.origin).toBe('SHACL');
    expect(c.sql).toBe(
        OPP_FOCUS('opportunity_id AS `opportunity_id`, opp_name AS `name`') +
        'SELECT\n' +
        '  COUNTIF(`name` IS NULL OR TRIM(CAST(`name` AS STRING)) = \'\') AS violations,\n' +
        '  COUNT(*) AS total\n' +
        'FROM focus');
    expect(c.examplesSql).toBe(
        OPP_FOCUS('opportunity_id AS `opportunity_id`, opp_name AS `name`') +
        'SELECT\n' +
        '  CAST(`opportunity_id` AS STRING) AS focus_key,\n' +
        '  CAST(`name` AS STRING) AS value\n' +
        'FROM focus\n' +
        'WHERE `name` IS NULL OR TRIM(CAST(`name` AS STRING)) = \'\'\n' +
        'LIMIT 5');
  });

  test('empty (SHACL maxCount 0)', () => {
    const c = only(shacl('Opportunity_stage_empty', 'stage', 'sh:maxCount 0'));
    expect(c.kind).toBe('empty');
    expect(c.sql).toContain('COUNTIF(`stage` IS NOT NULL) AS violations');
  });

  test('pattern with RE2 flags', () => {
    const c = only(shacl('Opportunity_name_pattern', 'name',
                         `sh:pattern '^[A-Z]' sh:flags 'i'`));
    expect(c.kind).toBe('pattern');
    expect(c.sql).toContain(
        "COUNTIF(`name` IS NOT NULL AND NOT REGEXP_CONTAINS(CAST(`name` AS STRING), '(?i)^[A-Z]')) AS violations");
  });

  test('in: members come from the judgment (they may contain spaces)', () => {
    const c = only(shacl(
        'Opportunity_stage_in', 'stage', 'sh:in (Open Closed Won Closed Lost)',
        "Every stage that is set is one of 'Open', 'Closed Won' or 'Closed Lost'. An Opportunity with any other stage does not satisfy this rule."));
    expect(c.kind).toBe('in');
    expect(c.sql).toContain(
        "COUNTIF(`stage` IS NOT NULL AND CAST(`stage` AS STRING) NOT IN ('Open', 'Closed Won', 'Closed Lost')) AS violations");
  });

  test('single-member sh:in checks present values only', () => {
    const c = only(shacl('Account_region_value_EMEA', 'region', 'sh:in (EMEA)',
                         "Every Account has region equal to 'EMEA'."));
    expect(c.kind).toBe('in');
    expect(c.sql).toContain(
        "COUNTIF(`region` IS NOT NULL AND CAST(`region` AS STRING) NOT IN ('EMEA')) AS violations");
  });

  test('value (OWL hasValue on a field) requires the value', () => {
    const c = only(owl('Account_region_value_EMEA',
                       "Account SubClassOf region value 'EMEA'"));
    expect(c.kind).toBe('value');
    expect(c.origin).toBe('OWL');
    expect(c.sql).toContain(
        "COUNTIF(`region` IS NULL OR CAST(`region` AS STRING) != 'EMEA') AS violations");
  });

  test('range: numeric bounds compare as BIGNUMERIC', () => {
    const c = only(shacl('Opportunity_amount_range', 'amount',
                         'sh:minInclusive 0 sh:maxExclusive 1000000'));
    expect(c.kind).toBe('range');
    expect(c.sql).toContain(
        "COUNTIF(`amount` IS NOT NULL AND (SAFE_CAST(CAST(`amount` AS STRING) AS BIGNUMERIC) < CAST('0' AS BIGNUMERIC) OR SAFE_CAST(CAST(`amount` AS STRING) AS BIGNUMERIC) >= CAST('1000000' AS BIGNUMERIC))) AS violations");
  });

  test('range: temporal bounds cast to the field type', () => {
    const c = only(shacl('Opportunity_close_date_min', 'close_date',
                         'sh:minInclusive 2000-01-01'));
    expect(c.sql).toContain(
        "COUNTIF(`close_date` IS NOT NULL AND (SAFE_CAST(CAST(`close_date` AS STRING) AS DATE) < SAFE_CAST('2000-01-01' AS DATE))) AS violations");
  });

  test('length', () => {
    const c = only(shacl('Opportunity_name_length', 'name',
                         'sh:minLength 2 sh:maxLength 80'));
    expect(c.kind).toBe('length');
    expect(c.sql).toContain(
        'COUNTIF(`name` IS NOT NULL AND (LENGTH(CAST(`name` AS STRING)) < 2 OR LENGTH(CAST(`name` AS STRING)) > 80)) AS violations');
  });

  test('lessThanOrEquals / lessThan pairs project both fields', () => {
    const lte = only(shacl('Opportunity_start_date_lte_close_date',
                           'start_date', 'sh:lessThanOrEquals close_date'));
    expect(lte.kind).toBe('lessThanOrEquals');
    expect(lte.sql).toContain(
        'SELECT opportunity_id AS `opportunity_id`, start_date AS `start_date`, close_date AS `close_date`');
    expect(lte.sql).toContain(
        'COUNTIF(`start_date` IS NOT NULL AND `close_date` IS NOT NULL AND `start_date` > `close_date`) AS violations');
    const lt = only(shacl('Opportunity_start_date_lt_close_date', 'start_date',
                          'sh:lessThan close_date'));
    expect(lt.sql).toContain(
        'COUNTIF(`start_date` IS NOT NULL AND `close_date` IS NOT NULL AND `start_date` >= `close_date`) AS violations');
  });

  test('cardinality (OWL exactly, forward): full golden', () => {
    const c = only(owl('Opportunity_hasBuyer_exactly_1',
                       'Opportunity SubClassOf hasBuyer exactly 1 Account'));
    expect(c.kind).toBe('cardinality');
    expect(c.field).toBe('hasBuyer');
    expect(c.sql).toBe(
        'WITH focus AS (\n' +
        '  SELECT opportunity_id AS `opportunity_id`, account_id AS `account_id`\n' +
        '  FROM `p.d.opportunity`\n' +
        '),\n' +
        'edges AS (\n' +
        '  SELECT `account_id` AS kcmd_j0, COUNT(*) AS kcmd_n\n' +
        '  FROM (\n' +
        '    SELECT account_id AS `account_id`\n' +
        '    FROM `p.d.account`\n' +
        '  )\n' +
        '  GROUP BY kcmd_j0\n' +
        '),\n' +
        'checked AS (\n' +
        '  SELECT focus.*, COALESCE(edges.kcmd_n, 0) AS kcmd_edge_count\n' +
        '  FROM focus\n' +
        '  LEFT JOIN edges ON focus.`account_id` = edges.kcmd_j0\n' +
        ')\n' +
        'SELECT\n' +
        '  COUNTIF(kcmd_edge_count < 1 OR kcmd_edge_count > 1) AS violations,\n' +
        '  COUNT(*) AS total\n' +
        'FROM checked');
  });

  test('cardinality read through an inverse counts source rows', () => {
    const c = only(owl('Account_hasOpportunity_min_1',
                       'Account SubClassOf hasOpportunity min 1 Opportunity'));
    expect(c.kind).toBe('cardinality');
    expect(c.entity).toBe('Account');
    expect(c.sql).toContain('FROM `p.d.opportunity`');
    expect(c.sql).toContain('WHERE `account_id` IS NOT NULL\n  GROUP BY kcmd_j0');
    expect(c.sql).toContain('COUNTIF(kcmd_edge_count < 1) AS violations');
  });

  test('functional property = at most one edge', () => {
    const c = only(owl('hasBuyer_functional', 'hasBuyer is a FunctionalProperty'));
    expect(c.kind).toBe('cardinality');
    expect(c.entity).toBe('Opportunity');
    expect(c.sql).toContain('COUNTIF(kcmd_edge_count > 1) AS violations');
  });

  test('class (OWL only X): every edge reaches an X', () => {
    const c = only(owl('Opportunity_hasBuyer_only_Partner',
                       'Opportunity SubClassOf hasBuyer only Partner'));
    expect(c.kind).toBe('class');
    expect(c.sql).toContain(
        'targets AS (\n  SELECT DISTINCT `account_id` AS kcmd_j0\n  FROM (\n    SELECT account_id AS `account_id`\n    FROM `p.d.partner`\n  )\n)');
    expect(c.sql).toContain(
        'COUNTIF(`account_id` IS NOT NULL AND NOT kcmd_match) AS violations');
  });

  test('disjoint classes share no key', () => {
    const c = only(owl('Account_disjoint_Partner', 'Account DisjointWith Partner'));
    expect(c.kind).toBe('disjointClasses');
    expect(c.sql).toContain(
        "SELECT CAST(`account_id` AS STRING) AS kcmd_key, 'Account' AS kcmd_class");
    expect(c.sql).toContain(
        "SELECT CAST(`account_id` AS STRING) AS kcmd_key, 'Partner' AS kcmd_class");
    expect(c.sql).toContain('COUNTIF(kcmd_classes > 1) AS violations');
  });

  test('structural checks: primary keys and foreign keys', () => {
    const plan = planBigQueryValidation(model([]));
    expect(plan.checks.map(c => `${c.id}:${c.kind}`)).toEqual([
      'Opportunity_primary_key:primaryKey',
      'Account_primary_key:primaryKey',
      'Partner_primary_key:primaryKey',
      'hasBuyer_references:references',
    ]);
    const pk = plan.checks.find(c => c.id === 'Account_primary_key')!;
    expect(pk.source).toBe('model');
    expect(pk.sql).toBe(
        'WITH focus AS (\n' +
        '  SELECT account_id AS `account_id`\n' +
        '  FROM `p.d.account`\n' +
        '),\n' +
        'checked AS (\n' +
        '  SELECT focus.*, COUNT(*) OVER (PARTITION BY `account_id`) AS kcmd_rows\n' +
        '  FROM focus\n' +
        ')\n' +
        'SELECT\n' +
        '  COUNTIF(`account_id` IS NULL OR kcmd_rows > 1) AS violations,\n' +
        '  COUNT(*) AS total\n' +
        'FROM checked');
    const fk = plan.checks.find(c => c.id === 'hasBuyer_references')!;
    expect(fk.entity).toBe('Opportunity');
    expect(fk.sql).toContain('FROM `p.d.account`');
    expect(fk.sql).toContain(
        'COUNTIF(`account_id` IS NOT NULL AND NOT kcmd_match) AS violations');
    expect(planBigQueryValidation(model([]), {structural: false}).checks).toEqual([]);
  });

  test('--examples sets the examples LIMIT', () => {
    const plan = planBigQueryValidation(
        model([shacl('Opportunity_name_required', 'name', 'sh:minCount 1')]),
        {structural: false, examples: 12});
    expect(plan.checks[0].examplesSql.endsWith('\nLIMIT 12')).toBe(true);
  });
});

describe('validate_bigquery: unsupported constraints', () => {
  const plan = planBigQueryValidation(model([
    {name: 'Big_deals_need_approval', judgment: 'A deal over 1M is approved.'} as Constraint,
    owl('Opportunity_hasBuyer_value_acme', "Opportunity SubClassOf hasBuyer value 'acme'"),
    shacl('Opportunity_probability_max', 'probability', 'sh:maxInclusive 1'),
    shacl('Opportunity_name_pattern', 'name', `sh:pattern 'x' sh:flags 'x'`),
    shacl('Opportunity_name_required', 'name', 'sh:minCount 1'),
  ]), {structural: false});

  test('each is listed with its reason, never guessed at', () => {
    expect(plan.checks.map(c => c.id)).toEqual(['Opportunity_name_required']);
    const reasons = Object.fromEntries(plan.unsupported.map(u => [u.constraint, u.reason]));
    expect(Object.keys(reasons)).toEqual([
      'Big_deals_need_approval',
      'Opportunity_hasBuyer_value_acme',
      'Opportunity_probability_max',
      'Opportunity_name_pattern',
    ]);
    expect(reasons['Big_deals_need_approval']).toContain('no SHACL/OWL provenance');
    expect(reasons['Opportunity_hasBuyer_value_acme']).toContain('names an individual');
    expect(reasons['Opportunity_probability_max'])
        .toContain("field 'Opportunity.probability' is not bound");
    expect(reasons['Opportunity_name_pattern']).toContain("regular-expression flag 'x'");
  });

  test('one warning lists them all', () => {
    const w = unsupportedWarning(plan)!;
    expect(w.split('\n')[0]).toBe(
        "4 constraint(s) of model 'sales' cannot be checked over BigQuery and are skipped:");
    expect(w).toContain('  - Big_deals_need_approval: ');
    expect(w).toContain('  - Opportunity_name_pattern: ');
    expect(unsupportedWarning({...plan, unsupported: []})).toBeUndefined();
  });

  test('parseConstraintSpec reads the provenance note', () => {
    expect(parseConstraintSpec(
               shacl('Opportunity_amount_range', 'amount', 'sh:maxInclusive 10'),
               model([])))
        .toEqual({
          spec: {
            kind: 'range',
            entity: 'Opportunity',
            field: 'amount',
            bounds: [{term: 'maxInclusive', value: '10'}],
          },
          origin: 'SHACL',
        });
  });
});

describe('validate_bigquery: manifest and .sql', () => {
  const plan = planBigQueryValidation(model([
    shacl('Opportunity_name_required', 'name', 'sh:minCount 1'),
    {name: 'Handwritten', judgment: 'Something.'} as Constraint,
  ]), {structural: false});

  test('manifest carries id, entity, field, kind and sql per check', () => {
    const m = validationManifest(
        plan, {profile: 'bigquery', generatedAt: '2026-01-01T00:00:00Z'});
    expect(m.model).toBe('sales');
    expect(m.profile).toBe('bigquery');
    expect(m.generatedAt).toBe('2026-01-01T00:00:00Z');
    expect(m.checks).toEqual([{
      id: 'Opportunity_name_required',
      constraint: 'Opportunity_name_required',
      source: 'constraint',
      origin: 'SHACL',
      kind: 'required',
      entity: 'Opportunity',
      field: 'name',
      sql: plan.checks[0].sql,
      examplesSql: plan.checks[0].examplesSql,
    }]);
    expect(m.unsupported.map(u => u.constraint)).toEqual(['Handwritten']);
    // JSON-serializable as written by the CLI.
    expect(JSON.parse(JSON.stringify(m))).toEqual(m);
  });

  test('.sql file: each count query then its examples, skipped ones noted', () => {
    const sql = renderValidationSql(plan, {profile: 'bigquery'});
    expect(sql).toContain("-- Generated by kcmd validate --target bigquery for model 'sales' (profile 'bigquery').");
    expect(sql).toContain('-- skipped Handwritten: ');
    expect(sql).toContain('-- [Opportunity_name_required] required on Opportunity (name)\n' +
                          plan.checks[0].sql + ';\n-- [Opportunity_name_required] examples\n' +
                          plan.checks[0].examplesSql + ';\n');
  });
});

describe('validate_bigquery: results and the Knowledge Catalog aspect', () => {
  const plan = planBigQueryValidation(model([
    shacl('Opportunity_name_required', 'name', 'sh:minCount 1'),
    {
      ...shacl('Opportunity_stage_empty', 'stage', 'sh:maxCount 0'),
      severity: 'high',
    } as Constraint,
    owl('Account_hasOpportunity_min_1',
        'Account SubClassOf hasOpportunity min 1 Opportunity'),
  ]), {structural: false});
  const [required, empty, card] = plan.checks;
  const results = [
    checkResult(required, {violations: 2, total: 10, examples: ['o1: ', 'o2: x']}, 'T1'),
    checkResult(empty, {violations: 0, total: 10}, 'T2'),
    checkResult(card, {error: 'Not found: Table p.d.account'}, 'T3'),
  ];

  test('status: fail with violations, pass without, error when it could not run', () => {
    expect(results.map(r => r.status)).toEqual(['fail', 'pass', 'error']);
  });

  test('payload: {constraint, kind, violations, total, examples, checkedAt, sql}', () => {
    expect(constraintResultPayload(results[0])).toEqual({
      constraint: 'Opportunity_name_required',
      kind: 'required',
      status: 'fail',
      field: 'name',
      violations: 2,
      total: 10,
      examples: ['o1: ', 'o2: x'],
      checkedAt: 'T1',
      sql: required.sql,
    });
    expect(constraintResultPayload(results[1]).severity).toBe('high');
    expect(constraintResultPayload(results[2])).toEqual({
      constraint: 'Account_hasOpportunity_min_1',
      kind: 'cardinality',
      status: 'error',
      field: 'hasBuyer',
      examples: [],
      checkedAt: 'T3',
      sql: card.sql,
      error: 'Not found: Table p.d.account',
    });
  });

  test('one entry update per entity, naming only the results aspect', () => {
    const dest = {project: 'proj', location: 'us', entryGroup: 'eg'};
    const updates = constraintResultsUpdates(
        results, dest, {model: 'sales', profile: 'bigquery', checkedAt: 'T'});
    expect(updates.map(u => u.name)).toEqual([
      'projects/proj/locations/us/entryGroups/eg/entries/sales.entities.Opportunity',
      'projects/proj/locations/us/entryGroups/eg/entries/sales.entities.Account',
    ]);
    const key = resultsAspectKey(dest);
    expect(key).toBe('proj.global.semantic-constraint-results');
    expect(Object.keys(updates[0].aspects!)).toEqual([key]);
    const aspect = updates[0].aspects![key];
    expect(aspect.aspectType)
        .toBe('projects/proj/locations/global/aspectTypes/semantic-constraint-results');
    expect(aspect.data!.model).toBe('sales');
    expect(aspect.data!.profile).toBe('bigquery');
    expect(aspect.data!.results.map((r: any) => r.constraint))
        .toEqual(['Opportunity_name_required', 'Opportunity_stage_empty']);
  });

  test('every payload key is a field of the aspect template', () => {
    const tpl = CONSTRAINT_RESULTS_ASPECT_TYPE.metadataTemplate;
    const top = tpl.recordFields.map((x: any) => x.name);
    const item = tpl.recordFields.find((x: any) => x.name === 'results')
                     .arrayItems.recordFields.map((x: any) => x.name);
    expect(top).toEqual(['model', 'profile', 'checkedAt', 'results']);
    for (const r of results) {
      for (const k of Object.keys(constraintResultPayload(r))) {
        expect(item).toContain(k);
      }
    }
  });

  test('entity entry names match the ones kcmd push publishes', () => {
    const dest = {project: 'proj', location: 'us', entryGroup: 'eg'};
    const m = model([]);
    const published = generateCatalogResources(m, dest).entries.map(e => e.name);
    for (const e of m.entities) {
      expect(published).toContain(entityEntryName(dest, m.name, e.name));
    }
  });

  test('console table', () => {
    const table = formatResultsTable(results);
    const lines = table.split('\n');
    expect(lines[0]).toMatch(/^CONSTRAINT\s+VIOLATIONS\s+TOTAL\s+STATUS$/);
    expect(lines[1]).toMatch(/^Opportunity_name_required\s+2\s+10\s+fail$/);
    expect(lines[2]).toMatch(/^Opportunity_stage_empty\s+0\s+10\s+pass$/);
    expect(lines[3]).toMatch(
        /^Account_hasOpportunity_min_1\s+-\s+-\s+error: Not found: Table p\.d\.account$/);
    expect(lines[lines.length - 1]).toBe('3 checked: 1 pass, 1 fail, 1 error');
  });
});
