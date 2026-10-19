// `kcmd bind`, step 3: hydration proposals from the profiler.
//
// Bind profiles the tables it chose with `kcmd profile`'s own statements (see
// profile_bigquery.ts) and turns three kinds of contradiction into hydration
// rules (see hydration.ts), each settled by one more read-only query:
//
//   key not unique      grain: {latest_by: <col>} -- the date / timestamp
//                       column whose greatest value is reached by one row per
//                       repeated key (at most 5% of them tie; name hints
//                       updated / modified / _at / created / _date, then
//                       column order, break ties); else {deterministic: true}
//   foreign-key orphans resolve: {field, match: [key, <unique field>...]} when
//                       orphaned values match a single-field unique key of
//                       the destination (or a vocabulary's labels),
//                       case-insensitively, as the node view compares
//   regime shift        normalize: {field, before, divide_by | multiply_by,
//                       on?} -- the boundary is the day that best splits the
//                       rows into the two scales, over each date column; the
//                       factor is the window medians' ratio, rounded to a
//                       power of ten when within 25% of one. PROPOSED OFF: a
//                       person confirms it (--accept-review)
//
// Pure: the queries are built here and their rows read here; run.ts runs them.

import {snakeCase} from '../generated_views';
import {isMatchableField, resolveRelationship} from '../hydration';
import {Entity, SemanticModel} from '../ir';
import {ProfileCheck, ProfileFinding, ProfilePlan, QueryOutcome, QueryRow} from '../profile_bigquery';
import {ScanTable, tableRef} from './scan';
import {Candidate, EntityBinding, isDateColumn} from './score';

/** Repeated keys allowed to tie on a latest_by column. */
export const TIE_TOLERANCE = 0.05;
/** Rows allowed on the wrong side of a normalize boundary for a clean split. */
export const SPLIT_TOLERANCE = 0.05;

export interface GrainProposal {
  latestBy?: string;
  deterministic?: true;
  evidence: string;
}

export interface ResolveProposal {
  field: string;
  relationship: string;
  destination: string;
  match: string[];
  evidence: string;
}

export interface NormalizeProposal {
  field: string;
  before: string;
  divideBy?: number;
  multiplyBy?: number;
  on?: string;
  evidence: string;
}

export interface EntityProposals {
  grain?: GrainProposal;
  resolve: ResolveProposal[];
  normalize: NormalizeProposal[];
  notes: string[];
}

export type Refinement =|{
  kind: 'grain';
  id: string;
  entity: string;
  dateColumns: string[];
  repeated: number;
  sql: string;
}|{
  kind: 'resolve';
  id: string;
  entity: string;
  field: string;
  relationship: string;
  destination: string;
  key: string;
  // Destination fields that may be matched, in slot order.
  unique: string[];
  sql: string;
}|{
  kind: 'normalize';
  id: string;
  entity: string;
  field: string;
  dateColumns: string[];
  before: number;
  after: number;
  ratio: number;
  shifts: number;
  window: string;
  sql: string;
};

export interface RefineContext {
  model: SemanticModel;
  bindings: EntityBinding[];
  tables: ReadonlyMap<string, ScanTable>;
  plan: ProfilePlan;
  findings: ProfileFinding[];
}

const q = (id: string) => `\`${id.replace(/`/g, '')}\``;
const norm = (expr: string) => `LOWER(TRIM(CAST(${expr} AS STRING)))`;

function sqlStringLiteral(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function columnOf(c: Candidate|undefined, field: string): string|undefined {
  return c?.matches.find(m => m.field === field)?.column;
}

/** The latest_by query: per date column, how many repeated keys tie at the max. */
export function grainSql(table: string, keyColumns: string[], dateColumns: string[]): string {
  const aggs = dateColumns.map(
      (c, i) => `ARRAY_AGG(${q(c)} IGNORE NULLS ORDER BY ${q(c)} DESC LIMIT 2) AS a${i}`);
  const ties = dateColumns.map(
      (_, i) => `COUNTIF(ARRAY_LENGTH(a${i}) = 0 OR (ARRAY_LENGTH(a${i}) = 2 AND a${
          i}[OFFSET(0)] = a${i}[OFFSET(1)])) AS ties_${i}`);
  return [
    `SELECT COUNT(*) AS repeated_keys${ties.length ? ',' : ''}`,
    ...ties.map((t, i) => `  ${t}${i < ties.length - 1 ? ',' : ''}`),
    'FROM (',
    `  SELECT ${aggs.length ? aggs.join(', ') : '1 AS one'}`,
    `  FROM ${q(table)}`,
    `  WHERE ${keyColumns.map(k => `${q(k)} IS NOT NULL`).join(' AND ')}`,
    `  GROUP BY ${keyColumns.map(q).join(', ')}`,
    '  HAVING COUNT(*) > 1)',
  ].join('\n');
}

/**
 * The resolve query: the distinct orphaned foreign-key values, and how many
 * match each candidate field of the destination. `keyValues` / `uniqueValues`
 * are SQL subqueries returning a column `v` of normalized values.
 */
export function resolveSql(
    source: string, fkColumn: string, keyValues: string, uniqueValues: string[]): string {
  return [
    `WITH k AS (${keyValues}),`,
    `o AS (SELECT DISTINCT ${norm(q(fkColumn))} AS v FROM ${q(source)}`,
    `  WHERE ${q(fkColumn)} IS NOT NULL AND ${norm(q(fkColumn))} NOT IN (SELECT v FROM k WHERE v IS NOT NULL))`,
    `SELECT (SELECT COUNT(*) FROM o) AS orphan_values${uniqueValues.length ? ',' : ''}`,
    ...uniqueValues.map((u, i) => `  (SELECT COUNT(*) FROM o WHERE v IN (SELECT v FROM (${
                                      u}) WHERE v IS NOT NULL)) AS matched_${i}${
                                      i < uniqueValues.length - 1 ? ',' : ''}`),
  ].join('\n');
}

function tableValues(table: string, column: string): string {
  return `SELECT DISTINCT ${norm(q(column))} AS v FROM ${q(table)}`;
}

function literalValues(values: string[]): string {
  const list = values.map(v => sqlStringLiteral(v.trim().toLowerCase()));
  return `SELECT v FROM UNNEST([${list.length ? list.join(', ') : "''"}]) AS v`;
}

/** The normalize query: rows per day above / below the midpoint, per date column. */
export function normalizeSql(
    table: string, column: string, dateColumns: string[], midpoint: number): string {
  const mid = Number(midpoint.toPrecision(6));
  const parts = dateColumns.map((d, i) => [
    `  (SELECT TO_JSON_STRING(ARRAY_AGG(STRUCT(d, b, s) ORDER BY d)) FROM (`,
    `    SELECT CAST(${q(d)} AS DATE) AS d, COUNTIF(ABS(${q(column)}) >= ${mid}) AS b,`,
    `      COUNTIF(ABS(${q(column)}) < ${mid}) AS s`,
    `    FROM ${q(table)}`,
    `    WHERE ${q(d)} IS NOT NULL AND ${q(column)} IS NOT NULL AND ${q(column)} != 0`,
    `    GROUP BY d)) AS days_${i}`,
  ].join('\n'));
  return `SELECT\n${parts.join(',\n')}`;
}

function vocabularyLabelField(e: Entity, b: EntityBinding|undefined): string|undefined {
  const mapped = b?.vocabFields?.find(v => v.column === 'label')?.field;
  if (mapped) return mapped;
  return (e.fields ?? []).find(f => snakeCase(f.name) === 'label')?.name;
}

/** The refinement queries the profile findings call for. */
export function planRefinements(ctx: RefineContext): Refinement[] {
  const out: Refinement[] = [];
  const byEntity = new Map(ctx.bindings.map(b => [b.entity, b]));
  const entities = new Map((ctx.model.entities ?? []).map(e => [e.name, e]));
  const checks = new Map(ctx.plan.checks.map(c => [c.id, c]));
  const bound = (name: string) => {
    const b = byEntity.get(name);
    return b?.chosen && (b.status === 'auto' || b.status === 'needs_review') ? b : undefined;
  };

  for (const f of ctx.findings) {
    if (f.status !== 'contradicted') continue;
    const check = checks.get(f.id);
    const b = bound(f.entity);
    const e = entities.get(f.entity);
    if (!check || !b || !e) continue;
    const table = ctx.tables.get(b.chosen!.table);
    if (!table) continue;
    const dates = table.columns.filter(isDateColumn).map(c => c.name);

    if (f.kind === 'primaryKey' && Number(f.evidence.duplicateRows ?? 0) > 0) {
      const keyCols = e.keys.map(k => columnOf(b.chosen, k));
      if (keyCols.some(c => !c)) continue;
      out.push({
        kind: 'grain',
        id: `grain:${e.name}`,
        entity: e.name,
        dateColumns: dates,
        repeated: Number(f.evidence.duplicateRows),
        sql: grainSql(b.chosen!.table, keyCols as string[], dates),
      });
    } else if (f.kind === 'orphans' && check.kind === 'orphans') {
      const r = (ctx.model.relationships ?? []).find(x => x.name === check.relationship);
      if (!r || r.source.columns.length !== 1) continue;
      const fk = r.source.columns[0];
      if (resolveRelationship(ctx.model, e, fk)?.name !== r.name) continue;
      const fkCol = columnOf(b.chosen, fk);
      const dest = entities.get(r.destination.entity);
      if (!fkCol || !dest || dest.keys.length !== 1 ||
          r.destination.columns[0] !== dest.keys[0]) {
        continue;
      }
      const db = byEntity.get(dest.name);
      let keyValues: string|undefined;
      const unique: string[] = [];
      const uniqueValues: string[] = [];
      if (dest.members !== undefined) {
        keyValues = literalValues(dest.members.map(m => m.code));
        // Matchable once bound to the view's `label` column, as bind binds it.
        const label = vocabularyLabelField(dest, db);
        if (label) {
          unique.push(label);
          uniqueValues.push(literalValues(dest.members.map(m => m.label ?? m.code)));
        }
      } else if (db?.chosen) {
        const keyCol = columnOf(db.chosen, dest.keys[0]);
        if (!keyCol) continue;
        keyValues = tableValues(db.chosen.table, keyCol);
        for (const u of dest.uniqueKeys ?? []) {
          if (u.length !== 1 || !isMatchableField(dest, u[0])) continue;
          const col = columnOf(db.chosen, u[0]);
          if (!col) continue;
          unique.push(u[0]);
          uniqueValues.push(tableValues(db.chosen.table, col));
        }
      }
      if (!keyValues || !unique.length) continue;
      out.push({
        kind: 'resolve',
        id: `resolve:${e.name}.${fk}`,
        entity: e.name,
        field: fk,
        relationship: r.name,
        destination: dest.name,
        key: dest.keys[0],
        unique,
        sql: resolveSql(b.chosen!.table, fkCol, keyValues, uniqueValues),
      });
    } else if (f.kind === 'regimeShift' && f.field) {
      const shifts = (f.evidence.shifts ?? []) as Array<{from: string; to: string; before: number; after: number; ratio: number}>;
      const s = shifts[0];
      const col = columnOf(b.chosen, f.field);
      if (!s || !col || !dates.length || !(s.before > 0) || !(s.after > 0)) continue;
      out.push({
        kind: 'normalize',
        id: `normalize:${e.name}.${f.field}`,
        entity: e.name,
        field: f.field,
        dateColumns: dates,
        before: s.before,
        after: s.after,
        ratio: s.ratio,
        shifts: shifts.length,
        window: `${s.from} -> ${s.to}`,
        sql: normalizeSql(b.chosen!.table, col, dates, Math.sqrt(s.before * s.after)),
      });
    }
  }
  return out;
}

function num(row: QueryRow, column: string): number {
  const v = row[column];
  const n = v === null || v === undefined ? 0 : Number(v);
  if (!Number.isFinite(n)) throw new Error(`column '${column}' is not a number`);
  return n;
}

// Lower is a better latest_by column name.
function hintRank(column: string): number {
  const c = column.toLowerCase();
  if (/updated|modified/.test(c)) return 0;
  if (/_at$/.test(c) && !/created/.test(c)) return 1;
  if (/created/.test(c)) return 2;
  if (/(_date|date)$/.test(c)) return 3;
  return 4;
}

/** The latest_by column (or deterministic) from the grain query's row. */
export function chooseLatestBy(dateColumns: string[], row: QueryRow): GrainProposal {
  const repeated = num(row, 'repeated_keys');
  const scored = dateColumns.map((c, i) => ({c, i, ties: num(row, `ties_${i}`)}));
  const ok = scored.filter(s => repeated > 0 && s.ties / repeated <= TIE_TOLERANCE)
                 .sort((a, b) => a.ties - b.ties || hintRank(a.c) - hintRank(b.c) || a.i - b.i);
  if (ok.length) {
    const best = ok[0];
    return {
      latestBy: best.c,
      evidence: `${repeated} repeated key(s); the greatest ${best.c} is one row for ${
          repeated - best.ties} of them${best.ties ? ` (${best.ties} tie, broken by a row hash)` : ''}`,
    };
  }
  const tried = scored.map(s => `${s.c}: ${s.ties} tie(s)`).join(', ');
  return {
    deterministic: true,
    evidence: `${repeated} repeated key(s); no date column picks one row per key${
        tried ? ` (${tried})` : ' (the table has no date column)'}`,
  };
}

export interface DaySplit {
  date: string;
  errors: number;
  total: number;
}

/**
 * The first day of the new scale that best splits `days` (rows above /
 * below the midpoint per day) into an old scale and a new one; `oldBig`
 * says the old scale is the larger.
 */
export function bestSplit(
    days: Array<{d: string; b: number; s: number}>, oldBig: boolean): DaySplit|undefined {
  if (days.length < 2) return undefined;
  const sorted = [...days].sort((x, y) => x.d.localeCompare(y.d));
  const total = sorted.reduce((t, x) => t + x.b + x.s, 0);
  // errors(k): rows before day k on the new scale + rows from day k on the old.
  let before = 0;
  let after = sorted.reduce((t, x) => t + (oldBig ? x.b : x.s), 0);
  let best: DaySplit|undefined;
  for (let k = 1; k < sorted.length; k++) {
    const prev = sorted[k - 1];
    before += oldBig ? prev.s : prev.b;
    after -= oldBig ? prev.b : prev.s;
    const errors = before + after;
    if (!best || errors < best.errors) best = {date: sorted[k].d, errors, total};
  }
  return best;
}

/** A ratio as a normalize factor: a power of ten when within 25% of one. */
export function roundFactor(ratio: number): number {
  const p = Math.pow(10, Math.round(Math.log10(ratio)));
  return Math.abs(ratio / p - 1) <= 0.25 ? p : Number(ratio.toPrecision(2));
}

/** True for 10, 100, 1000, ... (a unit change). */
export function isPowerOfTen(n: number): boolean {
  const l = Math.log10(n);
  return n > 1 && Math.abs(l - Math.round(l)) < 1e-9;
}

/**
 * Days whose majority sits on the wrong side of a split at `boundary` (the
 * first day of the new scale).
 */
export function daysOnWrongSide(
    days: Array<{d: string; b: number; s: number}>, boundary: string, oldBig: boolean): number {
  return days.filter(x => {
    const old = x.d < boundary;
    const bigger = x.b > x.s;
    const smaller = x.s > x.b;
    return old ? (oldBig ? smaller : bigger) : (oldBig ? bigger : smaller);
  }).length;
}

function parseDays(row: QueryRow, column: string): Array<{d: string; b: number; s: number}> {
  const v = row[column];
  if (v === null || v === undefined) return [];
  const parsed = JSON.parse(v);
  if (!Array.isArray(parsed)) return [];
  return parsed.map((x: any) => ({d: String(x.d), b: Number(x.b), s: Number(x.s)}));
}

function pct(part: number, whole: number): string {
  return whole ? `${Number(((100 * part) / whole).toFixed(2))}%` : '0%';
}

/** Reads the refinement rows into proposals per entity. */
export function evaluateRefinements(
    refinements: Refinement[], outcomes: ReadonlyMap<string, QueryOutcome>):
    Map<string, EntityProposals> {
  const out = new Map<string, EntityProposals>();
  const of = (entity: string) => {
    let p = out.get(entity);
    if (!p) {
      p = {resolve: [], normalize: [], notes: []};
      out.set(entity, p);
    }
    return p;
  };
  // Grain first: normalize defaults its `on` to grain.latest_by.
  const ordered = [...refinements].sort(
      (a, b) => Number(a.kind !== 'grain') - Number(b.kind !== 'grain'));
  for (const r of ordered) {
    const p = of(r.entity);
    const res = outcomes.get(r.sql);
    if (!res || 'error' in res) {
      p.notes.push(`${r.id}: the query ${res ? `failed: ${res.error.split('\n')[0]}` : 'was not run'}`);
      if (r.kind === 'grain') {
        p.grain = {deterministic: true, evidence: `${r.repeated} duplicate row(s); latest_by not settled`};
      }
      continue;
    }
    try {
      if (r.kind === 'grain') {
        p.grain = r.dateColumns.length ?
            chooseLatestBy(r.dateColumns, res.row) :
            {deterministic: true, evidence: `${r.repeated} duplicate row(s); the table has no date column`};
      } else if (r.kind === 'resolve') {
        const orphans = num(res.row, 'orphan_values');
        const matched = r.unique.map((u, i) => ({u, n: num(res.row, `matched_${i}`)}));
        const hits = matched.filter(m => m.n > 0);
        if (!hits.length) {
          p.notes.push(`${r.relationship}: ${orphans} orphaned value(s) of ${r.field} match no ${
              r.unique.join(' / ')} of ${r.destination}; nothing to resolve`);
          continue;
        }
        const n = hits.reduce((t, m) => t + m.n, 0);
        p.resolve.push({
          field: r.field,
          relationship: r.relationship,
          destination: r.destination,
          match: [r.key, ...hits.map(m => m.u)],
          evidence: `${orphans} distinct orphaned value(s) of ${r.field}; ${
              hits.map(m => `${m.n} match ${r.destination}.${m.u}`).join(', ')}${
              orphans > n ? `; ${orphans - n} still match nothing` : ''}`,
        });
      } else {
        const oldBig = r.before > r.after;
        const splits = r.dateColumns
                           .map((c, i) => ({c, i, split: bestSplit(parseDays(res.row, `days_${i}`), oldBig)}))
                           .filter((x): x is {c: string; i: number; split: DaySplit} => !!x.split);
        if (!splits.length) {
          p.notes.push(`${r.id}: no date column dates the shift (${r.window})`);
          continue;
        }
        const latestBy = p.grain?.latestBy;
        splits.sort((a, b) => a.split.errors / a.split.total - b.split.errors / b.split.total ||
                        Number(b.c === latestBy) - Number(a.c === latestBy) || a.i - b.i);
        const best = splits[0];
        const ratio = oldBig ? r.before / r.after : r.after / r.before;
        const factor = roundFactor(ratio);
        const days = parseDays(res.row, `days_${best.i}`);
        const wrongDays = daysOnWrongSide(days, best.split.date, oldBig);
        // Row by row, values on either scale overlap the midpoint (a small deal
        // before, a big one after), so the boundary is judged per day: a clean
        // one leaves every day's majority on its own side.
        const clean = wrongDays / Math.max(days.length, 1) <= SPLIT_TOLERANCE;
        const evidence = `median ${r.before} -> ${r.after} (x${r.ratio}) across ${r.window}${
            r.shifts > 1 ? ` (first of ${r.shifts} breaks)` : ''}; split on ${best.c} at ${
            best.split.date}: ${wrongDays} of ${days.length} day(s) on the wrong side, ${
            best.split.errors} of ${best.split.total} row(s) (${
            pct(best.split.errors, best.split.total)}) beyond the midpoint${
            clean ? '' : ' -- the boundary is not clean; check it'}`;
        if (!isPowerOfTen(factor)) {
          // A unit change (cents, thousands) rescales by a power of ten. Any
          // other jump is a change in what the series measures, which no
          // factor repairs.
          p.notes.push(`${r.field}: scale shift x${Number(ratio.toPrecision(3))} is not a power of ten, so not a unit change; no normalize proposed (${evidence})`);
          continue;
        }
        p.normalize.push({
          field: r.field,
          before: best.split.date,
          ...(oldBig ? {divideBy: factor} : {multiplyBy: factor}),
          ...(best.c !== latestBy ? {on: best.c} : {}),
          evidence,
        });
      }
    } catch (err) {
      p.notes.push(`${r.id}: unreadable result: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

/** The profiler checks bind reads: keys, orphans and regime shifts. */
export function bindChecks(checks: ProfileCheck[]): ProfileCheck[] {
  return checks.filter(c => c.kind === 'primaryKey' || c.kind === 'orphans' ||
                           c.kind === 'regimeShift');
}

/** `project.dataset.table` -> its scanned table. */
export function tablesByRef(tables: ScanTable[]): Map<string, ScanTable> {
  return new Map(tables.map(t => [tableRef(t), t]));
}
