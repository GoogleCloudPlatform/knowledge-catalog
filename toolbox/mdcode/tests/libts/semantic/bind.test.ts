// Behavior specification for `kcmd bind` (src/libts/semantic/bind/): the
// scan, entity -> table scoring with decoys and shadow tables, field -> column
// matching, derive_from and vocabulary bindings, the hydration proposals read
// from profiler findings, the profile writer, the orchestration over a mocked
// BigQuery, and a golden report over the professional-services prototype's
// real schema (fixtures/bind: the OWL import and its INFORMATION_SCHEMA dump).

import {describe, expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'yaml';

import {bestSplit, chooseLatestBy, daysOnWrongSide, evaluateRefinements, grainSql, isPowerOfTen, planRefinements, roundFactor, tablesByRef} from '../../../src/libts/semantic/bind/hydrate';
import {renderBindReport, renderProfileYaml} from '../../../src/libts/semantic/bind/report';
import {bindDocument, checkProfile, QueryFn} from '../../../src/libts/semantic/bind/run';
import {filterScan, globRegex, parseScanPattern, parseScanResult, scanFromCsv, scanSql, ScanTable, targetDataset} from '../../../src/libts/semantic/bind/scan';
import {bindEntities, bindSummary, deprecation, nameSimilarity, typeCompatible} from '../../../src/libts/semantic/bind/score';
import {SemanticModel} from '../../../src/libts/semantic/ir';
import {loadModels} from '../../../src/libts/semantic/loader';
import {ProfileFinding, ProfilePlan, QueryOutcome} from '../../../src/libts/semantic/profile_bigquery';

const FIXTURES = path.join(__dirname, 'fixtures', 'bind');

const MODEL = `
version: 0.2.0.dev0/google
semantic_model:
  - name: sales
    entities:
      - name: Opportunity
        primary_key: [opportunityId]
        ai_context: {synonyms: [Deal]}
        fields:
          - {name: opportunityId, datatype: String}
          - {name: wonAmount, datatype: Decimal}
          - {name: marketUnitCode, datatype: String}
          - {name: createdAt, datatype: DateTime}
          - {name: closeDate, datatype: Date}
          - {name: originatorId, datatype: String, label: lead originator ID}
          - {name: partnerName, datatype: String}
      - name: LegacyDeal
        primary_key: [legacyDealId]
        description: "DEPRECATED: Frozen extract of a retired deal system. Use Opportunity."
        fields:
          - {name: legacyDealId, datatype: String}
      - name: MarketUnit
        primary_key: [marketUnitCode]
        unique_keys: [[unitName]]
        fields:
          - {name: marketUnitCode, datatype: String}
          - {name: unitName, datatype: String}
      - name: Partner
        primary_key: [partnerName]
        fields:
          - {name: partnerName, datatype: String}
      - name: Stage
        primary_key: [stageCode]
        members:
          - {code: open, label: Open, order: 1}
          - {code: won, label: Won, order: 2}
        fields:
          - {name: stageCode, datatype: String}
          - {name: stageLabel, datatype: String}
          - {name: stageOrder, datatype: Integer}
      - name: WonOpportunity
        extends: [Opportunity]
        defined:
          expression: wonAmount > 0
    relationships:
      - {name: inMarketUnit, from: Opportunity, to: MarketUnit, from_columns: [marketUnitCode], to_columns: [marketUnitCode]}
      - {name: withPartner, from: Opportunity, to: Partner, from_columns: [partnerName], to_columns: [partnerName]}
`;

function cols(spec: string): ScanTable['columns'] {
  return spec.trim().split(/\s*,\s*/).map((s, i) => {
    const [name, type] = s.split(':');
    return {name, type, ordinal: i + 1};
  });
}

function table(dataset: string, name: string, spec: string): ScanTable {
  return {project: 'p', dataset, table: name, kind: 'BASE TABLE', columns: cols(spec)};
}

const OPP_COLUMNS = 'opportunity_id:STRING, won_amount:FLOAT64, market_unit:STRING, ' +
    'created_at:TIMESTAMP, close_date:STRING, lead_originator_id:STRING, partner_name:STRING';

const TABLES: ScanTable[] = [
  table('crm', 'opportunity', OPP_COLUMNS),
  // A frozen copy of the opportunity table: same columns, the deprecated name.
  table('crm', 'deal_legacy', OPP_COLUMNS),
  // A decoy: holds the opportunity key, little else.
  table('crm', 'opportunity_notes', 'note_id:STRING, opportunity_id:STRING, body:STRING'),
  table('crm', 'market_unit', 'market_unit:STRING, market_unit_name:STRING, currency_code:STRING'),
];

function model(): SemanticModel {
  return loadModels(MODEL, {bindingOptional: true}).models[0];
}

describe('the scan', () => {
  test('a pattern names a project and a dataset glob', () => {
    expect(parseScanPattern('kc-demo-349204.ps_*')).toEqual({project: 'kc-demo-349204', datasetGlob: 'ps_*'});
    expect(parseScanPattern('example.com:proj.ps_?')).toEqual({project: 'example.com:proj', datasetGlob: 'ps_?'});
    expect('error' in parseScanPattern('nodataset')).toBe(true);
    expect(globRegex('ps_*').test('ps_crm')).toBe(true);
    expect(globRegex('ps_*').test('xps_crm')).toBe(false);
  });

  test('one region-qualified query returns every table with its columns', () => {
    const sql = scanSql({project: 'p', datasetGlob: 'ps_*'}, 'US');
    expect(sql).toContain('`p`.`region-us`.INFORMATION_SCHEMA.COLUMNS');
    expect(sql).toContain("REGEXP_CONTAINS(table_schema, r'^ps_.*$')");
    const scan = parseScanResult('p', JSON.stringify([
      {d: 'ps_crm', t: 'b', k: 'BASE TABLE', c: [{n: 'y', ty: 'INT64', o: 2}, {n: 'x', ty: 'STRING', o: 1}]},
      {d: 'ps_crm', t: 'a', k: 'VIEW', c: []},
    ]));
    expect(scan.tables.map(t => t.table)).toEqual(['a', 'b']);
    expect(scan.tables[1].columns.map(c => c.name)).toEqual(['x', 'y']);
  });

  test('the deployment dataset, excluded globs and views are dropped', () => {
    const scan = {tables: [
      table('ps_crm', 'opportunity', 'opportunity_id:STRING'),
      table('ps_semantic', 'opportunity', 'opportunity_id:STRING'),
      {...table('ps_crm', 'v_opps', 'opportunity_id:STRING'), kind: 'VIEW'},
      table('other', 'x', 'a:STRING'),
    ]};
    const target = '//bigquery.googleapis.com/projects/p/datasets/ps_semantic/propertyGraphs/g';
    expect(targetDataset(target)).toBe('ps_semantic');
    const {tables, dropped} = filterScan(scan, {exclude: [targetDataset(target)!], datasetGlob: 'ps_*'});
    expect(tables.map(t => `${t.dataset}.${t.table}`)).toEqual(['ps_crm.opportunity']);
    expect(dropped.map(d => d.table)).toEqual(['ps_semantic.opportunity', 'ps_crm.v_opps']);
  });

  test('a COLUMNS CSV export reads as a scan', () => {
    const scan = scanFromCsv('table_schema,table_name,ordinal_position,column_name,data_type\n' +
                             'ps_crm,t,2,b,INT64\nps_crm,t,1,a,STRING\n', 'p');
    expect(scan.tables).toEqual([{project: 'p', dataset: 'ps_crm', table: 't', kind: 'BASE TABLE',
                                  columns: [{name: 'a', type: 'STRING', ordinal: 1}, {name: 'b', type: 'INT64', ordinal: 2}]}]);
  });
});

describe('names and types', () => {
  test('compacted names compare equal; plurals stem', () => {
    expect(nameSimilarity('QAHealthCheck', 'qa_healthcheck')).toBe(1);
    expect(nameSimilarity('Opportunity', 'opportunities')).toBe(1);
    expect(nameSimilarity('LegacyDeal', 'deal_legacy')).toBeGreaterThan(nameSimilarity('Deal', 'deal_legacy'));
  });

  test('numbers, dates and strings are each compatible within their group', () => {
    expect(typeCompatible('Decimal', 'FLOAT64')).toBe(true);
    expect(typeCompatible('DateTime', 'TIMESTAMP')).toBe(true);
    expect(typeCompatible('Date', 'STRING')).toBe(false);
    expect(typeCompatible(undefined, 'JSON')).toBe(true);
  });

  test('a deprecated entity names its replacement', () => {
    expect(deprecation(model().entities.find(e => e.name === 'LegacyDeal')!)).toEqual({use: 'Opportunity'});
    expect(deprecation(model().entities.find(e => e.name === 'Opportunity')!)).toBeUndefined();
  });
});

describe('entity -> table, field -> column', () => {
  const bindings = bindEntities(model(), TABLES);
  const of = (name: string) => bindings.find(b => b.entity === name)!;

  test('the authoritative table is auto-accepted over a decoy and a shadow', () => {
    const b = of('Opportunity');
    expect(b.status).toBe('auto');
    expect(b.chosen!.table).toBe('p.crm.opportunity');
    expect(b.reasons.some(r => r.includes('p.crm.deal_legacy') && r.includes('deprecated LegacyDeal'))).toBe(true);
    expect(b.candidates.find(c => c.table === 'p.crm.deal_legacy')?.shadowOf).toBe('LegacyDeal');
  });

  test('fields match by name, label and code suffix; a type mismatch is flagged', () => {
    const m = new Map(of('Opportunity').chosen!.matches.map(x => [x.field, x]));
    expect(m.get('wonAmount')).toMatchObject({column: 'won_amount', rule: 'name', typeOk: true});
    expect(m.get('originatorId')).toMatchObject({column: 'lead_originator_id', rule: 'label'});
    expect(m.get('marketUnitCode')).toMatchObject({column: 'market_unit', rule: 'code suffix'});
    expect(m.get('closeDate')).toMatchObject({column: 'close_date', typeOk: false, strength: 0.5});
  });

  test('a deprecated entity whose key has no column needs review, its key guessed', () => {
    const b = of('LegacyDeal');
    expect(b.status).toBe('needs_review');
    expect(b.chosen!.table).toBe('p.crm.deal_legacy');
    expect(b.chosen!.matches[0]).toMatchObject({column: 'opportunity_id', guessed: true});
  });

  test('a keyed entity with no table is derived from the edge into its key', () => {
    expect(of('Partner')).toMatchObject({status: 'derived', deriveFrom: {relationship: 'withPartner'}});
    expect(of('MarketUnit')).toMatchObject({status: 'auto'});
    expect(of('MarketUnit').chosen!.matches.find(m => m.field === 'unitName')!.column).toBe('market_unit_name');
  });

  test('a vocabulary binds to its view; a defined entity gets no table', () => {
    expect(of('Stage')).toMatchObject({status: 'vocabulary',
                                       vocabFields: [{field: 'stageLabel', column: 'label'}, {field: 'stageOrder', column: 'sort_order'}]});
    expect(of('WonOpportunity')).toMatchObject({status: 'no_table', parent: 'Opportunity'});
  });

  test('the summary counts auto and derived as accepted', () => {
    expect(bindSummary(bindings)).toMatchObject({concrete: 4, accepted: 3, acceptedShare: 0.75});
  });
});

describe('hydration proposals', () => {
  test('latest_by is the date column with no ties, else deterministic', () => {
    expect(chooseLatestBy(['close_at', 'created_at'], {repeated_keys: '10', ties_0: '4', ties_1: '0'}))
        .toMatchObject({latestBy: 'created_at'});
    expect(chooseLatestBy(['start_date', 'end_date'], {repeated_keys: '10', ties_0: '0', ties_1: '0'}))
        .toMatchObject({latestBy: 'start_date'});
    expect(chooseLatestBy(['d'], {repeated_keys: '10', ties_0: '5'})).toMatchObject({deterministic: true});
    expect(grainSql('p.crm.t', ['id'], ['created_at']))
        .toContain('ARRAY_AGG(`created_at` IGNORE NULLS ORDER BY `created_at` DESC LIMIT 2) AS a0');
  });

  test('the normalize boundary is the day that best splits the two scales', () => {
    const days = [
      {d: '2024-03-20', b: 5, s: 0}, {d: '2024-03-24', b: 4, s: 1},
      {d: '2024-03-25', b: 0, s: 6}, {d: '2024-04-02', b: 0, s: 7},
    ];
    expect(bestSplit(days, true)).toEqual({date: '2024-03-25', errors: 1, total: 23});
    expect(roundFactor(97.3)).toBe(100);
    expect(roundFactor(60)).toBe(60);
    expect(isPowerOfTen(100)).toBe(true);
    expect(isPowerOfTen(47000)).toBe(false);
    // Row overlap does not make a boundary unclean while each day's majority
    // is on its own side.
    expect(daysOnWrongSide(days, '2024-03-25', true)).toBe(0);
    expect(daysOnWrongSide(days, '2024-03-24', true)).toBe(1);
  });

  test('a scale shift that is no power of ten is noted, not normalized', () => {
    const r = {kind: 'normalize' as const, id: 'normalize:S.v', entity: 'S', field: 'v', dateColumns: ['d'],
               before: 500, after: 23_600_000, ratio: 47200, shifts: 1, window: '2024-01 -> 2024-04', sql: 'n'};
    const p = evaluateRefinements([r], new Map([['n', {row: {days_0: JSON.stringify(
        [{d: '2024-01-01', b: 0, s: 9}, {d: '2024-01-08', b: 9, s: 0}])}}]])).get('S')!;
    expect(p.normalize).toEqual([]);
    expect(p.notes[0]).toContain('not a power of ten');
  });

  test('profiler contradictions become grain, resolve and normalize proposals', () => {
    const m = model();
    const bindings = bindEntities(m, TABLES);
    const base = {statement: 's', origin: 'model' as const};
    const plan: ProfilePlan = {
      model: 'sales',
      options: {examples: 5, windowMonths: 3, shiftFactor: 50, magnitudeOrders: 2, minWindowRows: 30},
      checks: [
        {...base, id: 'pk', kind: 'primaryKey', entity: 'Opportunity', keys: ['opportunityId'], sql: 'q1'},
        {...base, id: 'fk', kind: 'orphans', entity: 'Opportunity', relationship: 'inMarketUnit', target: 'MarketUnit', sql: 'q2'},
        {...base, id: 'rs', kind: 'regimeShift', entity: 'Opportunity', field: 'wonAmount', timeField: 'createdAt',
         timeFieldFrom: 'dimension.is_time', slot: 0, sql: 'q3'},
      ],
      skipped: [],
      warnings: [],
    };
    const finding = (id: string, kind: ProfileFinding['kind'], evidence: Record<string, unknown>, field?: string): ProfileFinding =>
        ({...base, id, kind, entity: 'Opportunity', ...(field ? {field} : {}), status: 'contradicted', summary: '', evidence, sql: ''});
    const findings = [
      finding('pk', 'primaryKey', {duplicateRows: 3}),
      finding('fk', 'orphans', {orphanRows: 4}),
      finding('rs', 'regimeShift', {shifts: [{from: '2024-01', to: '2024-04', before: 50000, after: 500, ratio: 100}]}, 'wonAmount'),
    ];
    const refinements = planRefinements({model: m, bindings, tables: tablesByRef(TABLES), plan, findings});
    expect(refinements.map(r => r.id)).toEqual(['grain:Opportunity', 'resolve:Opportunity.marketUnitCode', 'normalize:Opportunity.wonAmount']);
    const rows: QueryOutcome[] = [
      {row: {repeated_keys: '3', ties_0: '0'}},
      {row: {orphan_values: '2', matched_0: '2'}},
      {row: {days_0: JSON.stringify([{d: '2024-03-20', b: 9, s: 0}, {d: '2024-03-25', b: 0, s: 8}])}},
    ];
    const outcomes = new Map(refinements.map((r, i) => [r.sql, rows[i]]));
    const p = evaluateRefinements(refinements, outcomes).get('Opportunity')!;
    expect(p.grain).toMatchObject({latestBy: 'created_at'});
    expect(p.resolve).toMatchObject([{field: 'marketUnitCode', match: ['marketUnitCode', 'unitName']}]);
    expect(p.normalize).toMatchObject([{field: 'wonAmount', before: '2024-03-25', divideBy: 100}]);
    expect(p.normalize[0].on).toBeUndefined();
  });
});

describe('the profile and the run', () => {
  // A mocked BigQuery: the opportunity key repeats; created_at picks one row.
  const query: QueryFn = async (sql): Promise<QueryOutcome> => {
    if (sql.includes('repeated_keys')) return {row: {repeated_keys: '2', ties_0: '0'}};
    if (sql.includes('null_keys') && sql.includes('p.crm.opportunity`')) {
      return {row: {total: '10', null_keys: '0', distinct_keys: '8', top_repeated: '[]'}};
    }
    return {error: 'not mocked'};
  };

  test('bind writes a profile that merges, loads and checks clean', async () => {
    const {results, models} = await bindDocument(
        {modelText: MODEL, docName: 'sales', tables: TABLES, profileName: 'bigquery', profileData: true}, query);
    const p = results[0].proposals.get('Opportunity');
    expect(p?.grain).toMatchObject({latestBy: 'created_at'});
    for (const acceptReview of [false, true]) {
      const meta = {profile: 'bigquery', scan: 'p.crm', tablesScanned: 4, dropped: [], acceptReview};
      const text = renderProfileYaml(results, meta);
      expect(checkProfile(MODEL, text, 'bigquery', 'sales')).toEqual([]);
      const doc = yaml.parse(text);
      const names = doc.semantic_model[0].entities.map((e: any) => e.name);
      expect(names.includes('LegacyDeal')).toBe(acceptReview);
      const opp = doc.semantic_model[0].entities.find((e: any) => e.name === 'Opportunity');
      expect(opp.source).toBe('//bigquery.googleapis.com/projects/p/datasets/crm/tables/opportunity');
      expect(opp.hydration).toEqual({grain: {latest_by: 'created_at'}});
      expect(doc.semantic_model[0].entities.find((e: any) => e.name === 'Partner'))
          .toEqual({name: 'Partner', hydration: {derive_from: {relationship: 'withPartner'}}});
      expect(renderBindReport(results, models, meta)).toContain('### Opportunity -- auto');
    }
  });
});

describe('golden: the professional-services prototype', () => {
  const modelText = fs.readFileSync(path.join(FIXTURES, 'ps_commercial.yaml'), 'utf8');
  const scan = scanFromCsv(fs.readFileSync(path.join(FIXTURES, 'columns.csv'), 'utf8'), 'kc-demo-349204');
  const {tables, dropped} = filterScan(scan, {exclude: ['ps_semantic'], datasetGlob: 'ps_*'});

  test('>= 90% of concrete entities accepted; every review item has a candidate', async () => {
    const {results, models} = await bindDocument(
        {modelText, docName: 'ps_commercial', tables, profileName: 'bigquery', profileData: false});
    const r = results[0];
    const s = bindSummary(r.bindings);
    expect(s.concrete).toBe(34);
    expect(s.acceptedShare).toBeGreaterThanOrEqual(0.9);
    expect(s.counts.unbound).toBe(0);
    for (const b of r.bindings.filter(x => x.status === 'needs_review')) {
      expect(b.chosen ?? b.candidates[0]).toBeDefined();
    }
    const of = (n: string) => r.bindings.find(b => b.entity === n)!;
    expect(of('EcosystemPartner')).toMatchObject({status: 'derived', deriveFrom: {relationship: 'allianceWith'}});
    expect(of('StageTransition').chosen!.table).toBe('kc-demo-349204.ps_crm.opportunity_stage_history');
    expect(of('SalesStage').vocabFields).toEqual([{field: 'stageLabel', column: 'label'}, {field: 'stageOrder', column: 'sort_order'}]);

    const meta = {profile: 'bigquery', scan: 'kc-demo-349204.ps_*', tablesScanned: tables.length, dropped, acceptReview: false};
    const profile = renderProfileYaml(results, meta);
    expect(checkProfile(modelText, profile, 'bigquery', 'ps_commercial', 'kc-demo-349204')).toEqual([]);
    expect(checkProfile(modelText, renderProfileYaml(results, {...meta, acceptReview: true}),
                        'bigquery', 'ps_commercial', 'kc-demo-349204')).toEqual([]);
    const report = renderBindReport(results, models, meta);
    for (const [file, text] of [['bind_report.golden.md', report], ['bigquery.golden.yaml', profile]]) {
      const golden = path.join(FIXTURES, file);
      if (process.env.UPDATE_GOLDEN || !fs.existsSync(golden)) fs.writeFileSync(golden, text);
      expect(text).toBe(fs.readFileSync(golden, 'utf8'));
    }
  });
});
