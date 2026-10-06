// Data profiling: the model's claims checked against the bound BigQuery data
// (`kcmd profile`, proposed -- see docs/semantic-model/profiling.md).
//
// A semantic model claims more about its data than its constraints state: a
// key identifies one row, a foreign-key relationship is many-to-one, a field
// takes only its declared values, a measure is in a unit, a series keeps one
// scale over time. `kcmd validate` counts violations of the model's RULES;
// this module measures the data behind those CLAIMS and settles each one as a
// STATEMENT with a status and the evidence for it:
//
//   verified      the data supports the claim, with the counts that show it;
//   unverified    the data cannot settle it (no rows, no peer to compare with,
//                 the query failed) or only raises a doubt (a unit whose
//                 magnitude is out of line with its peers);
//   contradicted  the data contradicts it (a repeated or null key, a foreign
//                 key that reaches several rows or none, a value outside the
//                 declared set, a null in a required field, an undeclared scale
//                 break over time).
//
// Six kinds of statement, each settled by one query generated from the model
// and the selected binding profile -- over the same rows validate_bigquery.ts
// reads (its Binder), so a class's instances mean the same thing in both:
//
//   1. primaryKey / uniqueKey  COUNT(*) against COUNT(DISTINCT key), null keys.
//   2. cardinality / orphans   per direct foreign-key relationship: the
//                              declared many-to-one (or one-to-one) against the
//                              rows each source row reaches, and the share of
//                              foreign-key values that reach no row.
//   3. enumCoverage            per `sh:in` rule: the share of values outside
//                              the declared set, the top offenders, and the
//                              declared values that never occur.
//   4. unitMagnitude           per field with a K7 `unit`: its median magnitude
//                              against the median of the other fields of the
//                              model with the same unit and scale.
//   5. regimeShift             per numeric field of an entity with a time
//                              field: the ratio between consecutive windows'
//                              medians; a declared regime (the proposed
//                              `Regime:` note) turns a break into `verified`.
//   6. requiredNulls           per required-field rule: null count and rate.
//
// Every threshold is generic and configurable (see PROFILE_DEFAULTS); nothing
// here knows any particular dataset. Like validate's results, the statuses are
// a REPORT about stored data, never a filter. Publishing writes them to
// Knowledge Catalog as an aspect on the entity entries, beside the
// constraint results.
//
// Layering: planning, SQL, evaluation, rendering and the aspect payloads are
// pure and unit-tested without a network; runBigQueryProfile and
// publishProfileResults at the bottom are the only functions that call an API.

import {ApiResult} from '../gcp/api';
import {BigQueryClient, QueryResponse} from '../gcp/bigquery';
import * as context from '../gcp/context';
import {AspectType, CatalogClient, Entry} from '../gcp/dataplex';

import {Entity, Field, Relationship, SemanticModel} from './ir';
import {scaleText} from './units_history';
import {allSet, Binder, columnOf, cte, entityEntryName, errorText, groupJ, indent, joinOn, KcDestination, keyExpr, parseConstraintSpec, projectJ, q, sqlString, str, table, Unsupported,} from './validate_bigquery';


// ---------------------------------------------------------------------------
// Statements, options and the plan.
// ---------------------------------------------------------------------------

export type ProfileStatus = 'verified'|'unverified'|'contradicted';

export type ProfileKind = 'primaryKey'|'uniqueKey'|'cardinality'|'orphans'|
    'enumCoverage'|'unitMagnitude'|'regimeShift'|'requiredNulls';

/** A relationship's declared cardinality, read source -> destination. */
export type Cardinality = 'many-to-one'|'one-to-one';

/** Where an entity's time field (for regime shifts) was found. */
export type TimeFieldSource =
    'history.valid_from'|'grain'|'dimension.is_time'|'first date field';

interface CheckBase {
  // Unique within the plan.
  id: string;
  // The entity the statement is about (and is published on).
  entity: string;
  // The field, key columns or relationship the statement is about.
  field?: string;
  // The model's claim, in words.
  statement: string;
  // `model`: stated by the model's structure or metadata; SHACL / OWL: by an
  // imported constraint (named in `constraint`).
  origin: 'model'|'SHACL'|'OWL';
  constraint?: string;
  // The query that settles the statement: it returns exactly one row. Several
  // statements may share one query (see the `slot` of the per-field kinds).
  sql: string;
}

export type ProfileCheck =|CheckBase&{kind: 'primaryKey' | 'uniqueKey'; keys: string[]}|
    CheckBase&{kind: 'cardinality'; relationship: string; target: string; declared: Cardinality}|
    CheckBase&{kind: 'orphans'; relationship: string; target: string}|
    CheckBase&{kind: 'enumCoverage'; values: string[]}|
    CheckBase&{kind: 'unitMagnitude'; unit: string; scale?: number; slot: number}|
    CheckBase&{
      kind: 'regimeShift';
      timeField: string;
      timeFieldFrom: TimeFieldSource;
      slot: number;
      regime?: string;
    }|
    CheckBase&{kind: 'requiredNulls'; slot: number};

export interface ProfilePlanOptions {
  // Offending values listed per statement (top repeated keys, orphaned
  // foreign keys, values outside a set). 0 lists none.
  examples?: number;
  // Regime shifts: the window length in months.
  windowMonths?: number;
  // Regime shifts: the ratio between consecutive windows' medians that counts
  // as a break.
  shiftFactor?: number;
  // Unit magnitude: how many orders of magnitude a field's median may sit from
  // its unit peers' median before it is flagged.
  magnitudeOrders?: number;
  // Regime shifts: the non-zero values a window needs to be compared at all.
  minWindowRows?: number;
}

export type ResolvedProfileOptions = Required<ProfilePlanOptions>;

export const PROFILE_DEFAULTS: ResolvedProfileOptions = {
  examples: 5,
  windowMonths: 3,
  shiftFactor: 50,
  magnitudeOrders: 2,
  minWindowRows: 30,
};

// Each option as its `kcmd profile` flag, and the values it accepts.
const OPTION_FLAGS: Record<keyof ProfilePlanOptions, {flag: string; rule: string; ok: (n: number) => boolean}> = {
  examples: {flag: '--examples', rule: 'a whole number >= 0', ok: n => Number.isInteger(n) && n >= 0},
  windowMonths: {flag: '--window-months', rule: 'a whole number >= 1', ok: n => Number.isInteger(n) && n >= 1},
  shiftFactor: {flag: '--shift-factor', rule: 'a number > 1', ok: n => Number.isFinite(n) && n > 1},
  magnitudeOrders: {flag: '--magnitude-orders', rule: 'a number > 0', ok: n => Number.isFinite(n) && n > 0},
  minWindowRows: {flag: '--min-window-rows', rule: 'a whole number >= 1', ok: n => Number.isInteger(n) && n >= 1},
};

/**
 * The plan options from `kcmd profile`'s tuning flags -- strings or numbers,
 * as the CLI parser hands them over; absent ones keep their default -- or the
 * first value out of range.
 */
export function parseProfileOptions(
    flags: Partial<Record<keyof ProfilePlanOptions, string|number>>): ProfilePlanOptions|{error: string} {
  const out: ProfilePlanOptions = {};
  for (const key of Object.keys(OPTION_FLAGS) as Array<keyof ProfilePlanOptions>) {
    const raw = flags[key];
    if (raw === undefined) continue;
    const n = typeof raw === 'number' ? raw : String(raw).trim() ? Number(raw) : NaN;
    const {flag, rule, ok} = OPTION_FLAGS[key];
    if (!ok(n)) return {error: `${flag} must be ${rule}; got '${raw}'`};
    out[key] = n;
  }
  return out;
}

/** A claim the profile could not turn into a query, and why. */
export interface SkippedStatement {
  subject: string;
  reason: string;
}

export interface ProfilePlan {
  model: string;
  options: ResolvedProfileOptions;
  checks: ProfileCheck[];
  skipped: SkippedStatement[];
  warnings: string[];
}

// Spec convention (proposed): a line `Regime: <what changed, and when>` in a
// field's (or its entity's) description or ai_context instructions declares a
// known change of scale or meaning over time. Kept to this one constant so it
// is easy to rename.
export const REGIME_PREFIX = 'Regime:';

const NUMERIC_TYPES = new Set(['Integer', 'Decimal', 'Float']);
const DATE_TYPES = new Set(['Date', 'DateTime', 'DateTimeTz']);

// A constraint that states a claim, and the language it came from.
interface Declared {
  constraint: string;
  origin: 'SHACL'|'OWL';
}


// ---------------------------------------------------------------------------
// Pure helpers over the model.
// ---------------------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Whether `text` names `name` as a whole word (case-insensitive).
function mentions(text: string, name: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(name)}([^A-Za-z0-9_]|$)`, 'i')
      .test(text);
}

/** The text after the first `Regime:` line of any of `texts`, if one has it. */
export function regimeNote(...texts: Array<string|undefined>): string|undefined {
  const word = escapeRegExp(REGIME_PREFIX.replace(/:\s*$/, ''));
  const line = new RegExp(`^\\s*${word}\\s*:\\s*(.*\\S)\\s*$`, 'i');
  for (const text of texts) {
    for (const l of (text ?? '').split('\n')) {
      const m = line.exec(l);
      if (m) return m[1];
    }
  }
  return undefined;
}

/**
 * The regime declared for `field` of `entity`: the field's own `Regime:` note,
 * else the entity's -- which covers the fields it names, or every field when
 * it names none of them.
 */
export function declaredRegime(entity: Entity, field: Field): string|undefined {
  const own = regimeNote(field.description, field.aiContext?.instructions);
  if (own) return own;
  const shared = regimeNote(entity.description, entity.aiContext?.instructions);
  if (!shared) return undefined;
  const named = entity.fields.filter(f => mentions(shared, f.name)).map(f => f.name);
  return !named.length || named.includes(field.name) ? shared : undefined;
}

function isDateField(f: Field): boolean {
  if (f.dimension?.isTime === false) return false;
  return f.type !== undefined ? DATE_TYPES.has(f.type) :
                                f.dimension?.isTime === true;
}

/**
 * The field a regime shift is measured over: the K7 `history.valid_from`,
 * else a date field the K7 `grain` names, else one marked
 * `dimension.is_time`, else the first DATE / DATETIME / TIMESTAMP field. Only
 * fields `isBound` accepts count.
 */
export function chooseTimeField(entity: Entity, isBound: (f: Field) => boolean):
    {field: Field; from: TimeFieldSource}|undefined {
  const usable = (f: Field|undefined): f is Field =>
      !!f && isDateField(f) && isBound(f);
  const validFrom = entity.history?.validFrom;
  const vf = validFrom === undefined ?
      undefined :
      entity.fields.find(f => f.name === validFrom);
  if (usable(vf)) return {field: vf, from: 'history.valid_from'};
  const grain = entity.grain;
  const named = grain ?
      entity.fields.find(f => usable(f) && mentions(grain, f.name)) :
      undefined;
  if (named) return {field: named, from: 'grain'};
  const explicit = entity.fields.find(f => usable(f) && f.dimension?.isTime === true);
  if (explicit) return {field: explicit, from: 'dimension.is_time'};
  const first = entity.fields.find(f => usable(f));
  return first ? {field: first, from: 'first date field'} : undefined;
}

function hasTable(e: Entity): boolean {
  return !e.abstract && !!e.dataSource?.trim() &&
      !e.dataSource.startsWith('unbound:');
}

function quoteList(values: string[]): string {
  const quoted = values.map(v => `'${v}'`);
  return quoted.length === 1 ?
      quoted[0] :
      `${quoted.slice(0, -1).join(', ')} or ${quoted[quoted.length - 1]}`;
}

function unitLabel(unit: string, scale?: number): string {
  return scale !== undefined ? `${unit} (${scaleText(scale)})` : unit;
}

function columnsLabel(cols: string[]): string {
  return cols.length === 1 ? cols[0] : `(${cols.join(', ')})`;
}


// ---------------------------------------------------------------------------
// SQL. Every query returns exactly one row of named columns.
// ---------------------------------------------------------------------------

// Cross-joins one-row CTEs into the result row.
function oneRow(ctes: string[], rows: string[]): string {
  return `WITH ${ctes.join(',\n')}\nSELECT *\nFROM ${rows.join(' CROSS JOIN ')}`;
}

// A one-row CTE holding the `limit` most frequent `value`s of the rows of
// `from` matching `where`, as a JSON array of {value, count}.
function topCte(
    name: string, column: string, value: string, from: string, where: string,
    limit: number, having?: string): string {
  const inner = `SELECT ${value} AS kcmd_value, COUNT(*) AS kcmd_n\nFROM ${
      from}\nWHERE ${where}\nGROUP BY kcmd_value${having ? `\nHAVING ${having}` : ''}`;
  return cte(
      name,
      `SELECT TO_JSON_STRING(ARRAY_AGG(STRUCT(kcmd_value AS value, kcmd_n AS count) ORDER BY kcmd_n DESC, kcmd_value LIMIT ${
          limit})) AS ${column}\nFROM (\n${indent(inner)}\n)`);
}

function selectList(items: string[]): string {
  return `SELECT\n${items.map(i => `  ${i}`).join(',\n')}`;
}

// 1. A key over one table (the raw columns, as validate's key checks read).
function keySql(e: Entity, cols: string[], examples: number): string {
  const set = allSet(cols);
  const ctes = [
    cte('focus',
        `SELECT ${cols.map(f => `${columnOf(e, f)} AS ${q(f)}`).join(', ')}\nFROM ${
            table(e)}`),
    cte('stats', `${selectList([
          'COUNT(*) AS total',
          `COUNTIF(${cols.map(c => `${q(c)} IS NULL`).join(' OR ')}) AS null_keys`,
          `COUNT(DISTINCT IF(${set}, ${keyExpr(cols)}, NULL)) AS distinct_keys`,
        ])}\nFROM focus`),
  ];
  const rows = ['stats'];
  if (examples > 0) {
    ctes.push(topCte('repeated', 'top_repeated', keyExpr(cols), 'focus', set,
                     examples, 'kcmd_n > 1'));
    rows.push('repeated');
  }
  return oneRow(ctes, rows);
}

// 2. A direct foreign-key relationship: per source row, how many destination
// rows its foreign key reaches; per reached destination, how many sources.
function relationshipSql(rel: Relationship, binder: Binder, examples: number): string {
  const F = rel.source.columns;
  const D = rel.destination.columns;
  if (!F.length || F.length !== D.length) {
    throw new Unsupported(`relationship '${rel.name}' has no join columns`);
  }
  const S = rel.source.entity;
  const T = rel.destination.entity;
  const set = allSet(F);
  const orphan = `${set} AND kcmd_targets = 0`;
  const ctes = [
    cte('src', binder.rows(S, [...binder.keys(S), ...F])),
    cte('dst',
        `SELECT ${projectJ(D)}, COUNT(*) AS kcmd_n\nFROM (\n${
            indent(binder.rows(T, [...binder.keys(T), ...D]))}\n)\nWHERE ${
            allSet(D)}\nGROUP BY ${groupJ(D)}`),
    cte('joined',
        `SELECT src.*, IFNULL(dst.kcmd_n, 0) AS kcmd_targets\nFROM src\nLEFT JOIN dst ON ${
            joinOn('src', F, 'dst')}`),
    cte('stats', `${selectList([
          'COUNT(*) AS total',
          `COUNTIF(${set}) AS fk_rows`,
          `COUNTIF(${orphan}) AS orphan_rows`,
          `COUNT(DISTINCT IF(${orphan}, ${keyExpr(F)}, NULL)) AS orphan_values`,
          'COUNTIF(kcmd_targets > 1) AS fanout_rows',
          'IFNULL(MAX(kcmd_targets), 0) AS max_targets',
        ])}\nFROM joined`),
    cte('sources',
        `SELECT IFNULL(MAX(kcmd_n), 0) AS max_sources\nFROM (\n${
            indent(`SELECT COUNT(*) AS kcmd_n\nFROM joined\nWHERE kcmd_targets > 0\nGROUP BY ${
                keyExpr(F)}`)}\n)`),
  ];
  const rows = ['stats', 'sources'];
  if (examples > 0) {
    ctes.push(topCte('orphans', 'top_orphans', keyExpr(F), 'joined', orphan, examples));
    rows.push('orphans');
  }
  return oneRow(ctes, rows);
}

// 3. One field against its declared values. The declared values are inlined
// as literals and the rows are read only in FROM clauses: the declared values
// that occur are collected in the same scan instead of an `IN (SELECT ...)`
// subquery, which BigQuery cannot de-correlate when the bound table is a view
// computing the field with its own correlated lookup (a code matched against
// a vocabulary table, say).
function enumSql(
    entity: string, field: string, values: string[], binder: Binder,
    examples: number): string {
  const f = q(field);
  const list = values.map(sqlString).join(', ');
  const outside = `${f} IS NOT NULL AND ${str(field)} NOT IN (${list})`;
  const ctes = [
    cte('focus', binder.rows(entity, [...binder.keys(entity), field])),
    cte('stats', `${selectList([
          'COUNT(*) AS total',
          `COUNTIF(${f} IS NOT NULL) AS non_null`,
          `COUNTIF(${outside}) AS outside_rows`,
          `COUNT(DISTINCT IF(${outside}, ${str(field)}, NULL)) AS outside_values`,
          `TO_JSON_STRING(ARRAY_AGG(DISTINCT IF(${str(field)} IN (${list}), ${
              str(field)}, NULL) IGNORE NULLS)) AS used_values`,
        ])}\nFROM focus`),
  ];
  const rows = ['stats'];
  if (examples > 0) {
    ctes.push(topCte('outside', 'top_outside', str(field), 'focus', outside, examples));
    rows.push('outside');
  }
  return oneRow(ctes, rows);
}

// 4. Median magnitude (|value|, zeros left out) of each column of one table.
function unitSql(e: Entity, columns: string[]): string {
  const items = ['COUNT(*) AS total'];
  columns.forEach((c, i) => {
    const v = `NULLIF(SAFE_CAST(${c} AS FLOAT64), 0)`;
    items.push(`COUNT(${v}) AS values_${i}`,
               `APPROX_QUANTILES(ABS(${v}), 2)[SAFE_OFFSET(1)] AS median_${i}`);
  });
  return `${selectList(items)}\nFROM ${table(e)}`;
}

// 5. Per window of `months` months of the time column: each column's count of
// non-zero values and median magnitude, as one JSON series.
function regimeSql(e: Entity, time: string, columns: string[], months: number): string {
  const focus = cte('focus', `${selectList([
                      `SAFE_CAST(${time} AS DATE) AS kcmd_time`,
                      ...columns.map((c, i) => `SAFE_CAST(${c} AS FLOAT64) AS kcmd_v${i}`),
                    ])}\nFROM ${table(e)}`);
  const aggregates = [
    `DIV(EXTRACT(YEAR FROM kcmd_time) * 12 + EXTRACT(MONTH FROM kcmd_time) - 1, ${
        months}) AS kcmd_window`,
  ];
  columns.forEach((_, i) => aggregates.push(
                      `COUNT(NULLIF(kcmd_v${i}, 0)) AS n${i}`,
                      `APPROX_QUANTILES(ABS(NULLIF(kcmd_v${i}, 0)), 2)[SAFE_OFFSET(1)] AS m${i}`));
  const windows = cte('windows', `${selectList(aggregates)}\nFROM focus\nWHERE kcmd_time IS NOT NULL\nGROUP BY kcmd_window`);
  const fields = ['kcmd_window AS w', ...columns.flatMap((_, i) => [`n${i}`, `m${i}`])];
  return `WITH ${focus},\n${windows}\nSELECT TO_JSON_STRING(ARRAY_AGG(STRUCT(${
      fields.join(', ')}) ORDER BY kcmd_window)) AS series\nFROM windows`;
}

// 6. Null counts of required fields over a class's rows.
function requiredSql(entity: string, fields: string[], binder: Binder): string {
  return `WITH ${cte('focus', binder.rows(entity, [...binder.keys(entity), ...fields]))}\n${
      selectList([
        'COUNT(*) AS total',
        ...fields.map((f, i) => `COUNTIF(${q(f)} IS NULL) AS nulls_${i}`),
      ])}\nFROM focus`;
}


// ---------------------------------------------------------------------------
// Planning.
// ---------------------------------------------------------------------------

class Planner {
  readonly binder: Binder;
  readonly checks: ProfileCheck[] = [];
  readonly skipped: SkippedStatement[] = [];
  private readonly ids = new Set<string>();

  constructor(readonly model: SemanticModel, readonly opts: ResolvedProfileOptions) {
    this.binder = new Binder(model);
  }

  claim(base: string): string {
    let id = base;
    for (let i = 2; this.ids.has(id); i++) id = `${base}_${i}`;
    this.ids.add(id);
    return id;
  }

  // Records why a claim has no query; anything but Unsupported is a bug.
  skip(subject: string, err: unknown): void {
    if (!(err instanceof Unsupported)) throw err;
    this.skipped.push({subject, reason: err.message});
  }

  // The bound column of `field` on `e`'s own table, or undefined.
  boundColumn(e: Entity, field: string): string|undefined {
    try {
      return this.binder.column(e, field);
    } catch (err) {
      if (!(err instanceof Unsupported)) throw err;
      return undefined;
    }
  }

  private lineage(name: string): Set<string> {
    const out = new Set<string>();
    const queue = [name];
    while (queue.length) {
      const n = queue.shift()!;
      if (out.has(n)) continue;
      out.add(n);
      queue.push(...(this.binder.tables.get(n)?.extends ?? []));
    }
    return out;
  }

  // Keys, unique keys and join columns: identifiers, not measures.
  private identifiers(e: Entity): Set<string> {
    const out = new Set<string>([...(e.keys ?? []), ...(e.uniqueKeys ?? []).flat()]);
    const lineage = this.lineage(e.name);
    for (const rel of this.binder.loweredRelationships) {
      if (lineage.has(rel.source.entity)) rel.source.columns.forEach(c => out.add(c));
      if (lineage.has(rel.destination.entity)) {
        rel.destination.columns.forEach(c => out.add(c));
      }
    }
    return out;
  }

  // 1. One key statement per table and key (a subtype sharing its parent's
  // table states the same key over the same rows).
  keys(): void {
    const seen = new Set<string>();
    for (const e of this.binder.tables.values()) {
      if (!this.binder.isTableBacked(e)) {
        if (!e.abstract && e.keys?.length) {
          this.skipped.push({
            subject: `${e.name} key ${columnsLabel(e.keys)}`,
            reason: `entity '${e.name}' has no bound table under this binding`,
          });
        }
        continue;
      }
      const sets: Array<{kind: 'primaryKey'|'uniqueKey'; cols: string[]}> = [
        {kind: 'primaryKey', cols: e.keys},
        ...(e.uniqueKeys ?? []).map(cols => ({kind: 'uniqueKey' as const, cols})),
      ];
      for (const {kind, cols} of sets) {
        const dedupe = `${e.dataSource.trim()}|${kind}|${cols.join(',')}`;
        if (!cols.length || seen.has(dedupe)) continue;
        seen.add(dedupe);
        const base = kind === 'primaryKey' ? `${e.name}_primary_key` :
                                             `${e.name}_unique_${cols.join('_')}`;
        try {
          const sql = keySql(e, cols, this.opts.examples);
          this.checks.push({
            id: this.claim(base),
            kind,
            entity: e.name,
            field: cols.join(', '),
            keys: cols,
            origin: 'model',
            statement: kind === 'primaryKey' ?
                `${columnsLabel(cols)} identifies each ${e.name}: never null, never repeated.` :
                `No two ${e.name} rows share ${columnsLabel(cols)}.`,
            sql,
          });
        } catch (err) {
          this.skip(`${e.name} key ${columnsLabel(cols)}`, err);
        }
      }
    }
  }

  // The constraints that state a relationship's cardinality on its own
  // endpoints: a forward `max 1` on the source (an OWL FunctionalProperty, a
  // SHACL `sh:maxCount 1`) restates the many-to-one; a backward one on the
  // destination (an OWL `max 1` / `exactly 1` through the inverse name) makes
  // it one-to-one. A restriction on a subtype claims less, so it is left out.
  private declaredCardinality(): Map<string, {forward?: Declared; inverse?: Declared}> {
    const out = new Map<string, {forward?: Declared; inverse?: Declared}>();
    const authored = new Map((this.model.relationships ?? []).map(r => [r.name, r]));
    for (const c of this.model.constraints ?? []) {
      const parsed = parseConstraintSpec(c, this.model);
      if ('unsupported' in parsed) continue;
      const {spec, origin} = parsed;
      if (spec.kind !== 'cardinality' || spec.qualifier || spec.max !== 1) continue;
      const rel = authored.get(spec.relationship);
      const end = spec.inverse ? rel?.destination.entity : rel?.source.entity;
      if (!rel || spec.entity !== end) continue;
      const side = spec.inverse ? 'inverse' : 'forward';
      const entry = out.get(rel.name) ?? {};
      if (!entry[side]) entry[side] = {constraint: c.name, origin};
      out.set(rel.name, entry);
    }
    return out;
  }

  // 2. Two statements per direct foreign-key relationship, one query.
  relationships(): void {
    const declared = this.declaredCardinality();
    for (const rel of this.binder.loweredRelationships) {
      // An abstract relationship has no join of its own; its sub-relationships
      // are profiled themselves.
      if (rel.abstract) continue;
      if (rel.association) {
        this.skipped.push({
          subject: `relationship ${rel.name}`,
          reason: `relationship '${rel.name}' is backed by an association table; not profiled yet`,
        });
        continue;
      }
      let sql: string;
      try {
        sql = relationshipSql(rel, this.binder, this.opts.examples);
      } catch (err) {
        this.skip(`relationship ${rel.name}`, err);
        continue;
      }
      const S = rel.source.entity;
      const T = rel.destination.entity;
      const one = declared.get(rel.name)?.inverse;
      const stated = one ?? declared.get(rel.name)?.forward;
      this.checks.push({
        id: this.claim(`${rel.name}_cardinality`),
        kind: 'cardinality',
        entity: S,
        field: rel.name,
        relationship: rel.name,
        target: T,
        declared: one ? 'one-to-one' : 'many-to-one',
        origin: stated ? stated.origin : 'model',
        ...(stated ? {constraint: stated.constraint} : {}),
        statement: one ?
            `Each ${S} has at most one ${T} through ${rel.name}, and each ${T} at most one ${S} (one-to-one).` :
            `Each ${S} has at most one ${T} through ${rel.name} (many-to-one).`,
        sql,
      });
      this.checks.push({
        id: this.claim(`${rel.name}_orphans`),
        kind: 'orphans',
        entity: S,
        field: rel.name,
        relationship: rel.name,
        target: T,
        origin: 'model',
        statement: `Every ${S}.${columnsLabel(rel.source.columns)} that is set matches a row of ${
            T} (${rel.name}).`,
        sql,
      });
    }
  }

  // 3 and 6. The constraint-backed claims: declared value sets and required
  // fields. Every other rule is validate's to count, not a profile statement.
  constraints(): {required: () => void} {
    const required = new Map<string, Array<{name: string; origin: 'SHACL'|'OWL'; field: string}>>();
    for (const c of this.model.constraints ?? []) {
      const parsed = parseConstraintSpec(c, this.model);
      if ('unsupported' in parsed) continue;
      const {spec, origin} = parsed;
      if (spec.kind === 'required') {
        required.set(spec.entity, [
          ...(required.get(spec.entity) ?? []),
          {name: c.name, origin, field: spec.field},
        ]);
        continue;
      }
      if (spec.kind !== 'in') continue;
      const values = [...new Set(spec.values)];
      try {
        const sql = enumSql(spec.entity, spec.field, values, this.binder, this.opts.examples);
        this.checks.push({
          id: this.claim(c.name),
          kind: 'enumCoverage',
          entity: spec.entity,
          field: spec.field,
          values,
          origin,
          constraint: c.name,
          statement: values.length <= 6 ?
              `Every ${spec.entity}.${spec.field} that is set is one of ${quoteList(values)}.` :
              `Every ${spec.entity}.${spec.field} that is set is one of its ${
                  values.length} declared values.`,
          sql,
        });
      } catch (err) {
        this.skip(`constraint ${c.name}`, err);
      }
    }
    // Required fields are planned last (the user-facing order), per entity.
    return {
      required: () => {
        for (const [entity, rules] of required) {
          const fields: string[] = [];
          for (const r of rules) {
            if (fields.includes(r.field)) continue;
            try {
              this.binder.rows(entity, [...this.binder.keys(entity), r.field]);
              fields.push(r.field);
            } catch (err) {
              this.skip(`constraint ${r.name}`, err);
            }
          }
          if (!fields.length) continue;
          const sql = requiredSql(entity, fields, this.binder);
          for (const r of rules) {
            const slot = fields.indexOf(r.field);
            if (slot < 0) continue;
            this.checks.push({
              id: this.claim(r.name),
              kind: 'requiredNulls',
              entity,
              field: r.field,
              slot,
              origin: r.origin,
              constraint: r.name,
              statement: `Every ${entity} has a value for ${entity}.${r.field}.`,
              sql,
            });
          }
        }
      },
    };
  }

  // 4. One unit statement per measured column, one query per table.
  units(): void {
    const seen = new Set<string>();
    for (const e of this.binder.tables.values()) {
      if (!hasTable(e)) continue;
      const picked: Array<{field: Field; column: string}> = [];
      for (const f of e.fields) {
        const unit = f.unit?.trim();
        if (!unit || (f.type !== undefined && !NUMERIC_TYPES.has(f.type))) continue;
        const column = this.boundColumn(e, f.name);
        if (column === undefined) {
          this.skipped.push({
            subject: `${e.name}.${f.name} unit`,
            reason: `field '${e.name}.${f.name}' is not bound under this binding`,
          });
          continue;
        }
        const key = `${e.dataSource.trim()}|${column}`;
        if (seen.has(key)) continue;
        seen.add(key);
        picked.push({field: f, column});
      }
      if (!picked.length) continue;
      const sql = unitSql(e, picked.map(p => p.column));
      picked.forEach(({field}, slot) => {
        const unit = field.unit!.trim();
        this.checks.push({
          id: this.claim(`${e.name}_${field.name}_unit`),
          kind: 'unitMagnitude',
          entity: e.name,
          field: field.name,
          unit,
          ...(field.scale !== undefined ? {scale: field.scale} : {}),
          slot,
          origin: 'model',
          statement: `${e.name}.${field.name} is in ${unitLabel(unit, field.scale)}.`,
          sql,
        });
      });
    }
  }

  // 5. One regime statement per numeric column of a table with a time field.
  regimes(): void {
    const seen = new Set<string>();
    for (const e of this.binder.tables.values()) {
      if (!hasTable(e)) continue;
      const time = chooseTimeField(e, f => this.boundColumn(e, f.name) !== undefined);
      if (!time) continue;
      const timeColumn = this.boundColumn(e, time.field.name)!;
      const identifiers = this.identifiers(e);
      const picked: Array<{field: Field; column: string}> = [];
      for (const f of e.fields) {
        if (f.name === time.field.name || identifiers.has(f.name)) continue;
        const numeric = f.type !== undefined ? NUMERIC_TYPES.has(f.type) :
                                               !!f.unit?.trim();
        if (!numeric) continue;
        const column = this.boundColumn(e, f.name);
        if (column === undefined) continue;
        const key = `${e.dataSource.trim()}|${timeColumn}|${column}`;
        if (seen.has(key)) continue;
        seen.add(key);
        picked.push({field: f, column});
      }
      if (!picked.length) continue;
      const sql = regimeSql(e, timeColumn, picked.map(p => p.column), this.opts.windowMonths);
      picked.forEach(({field}, slot) => {
        const regime = declaredRegime(e, field);
        this.checks.push({
          id: this.claim(`${e.name}_${field.name}_regime`),
          kind: 'regimeShift',
          entity: e.name,
          field: field.name,
          timeField: time.field.name,
          timeFieldFrom: time.from,
          slot,
          ...(regime ? {regime} : {}),
          origin: 'model',
          statement: `${e.name}.${field.name} keeps one scale over time (by ${e.name}.${
              time.field.name}).`,
          sql,
        });
      });
    }
  }
}

function resolveOptions(options: ProfilePlanOptions): ResolvedProfileOptions {
  const out = {...PROFILE_DEFAULTS};
  for (const [k, v] of Object.entries(options) as Array<[keyof ProfilePlanOptions, number|undefined]>) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Turns the claims of `model` (the AUTHORED model, merged with the selected
 * binding profile but not inheritance-resolved, as validate takes it) into
 * statements, each with the one-row query that settles it over the bound
 * BigQuery tables. A claim with no query is listed in `skipped` with the
 * reason; nothing is dropped silently.
 */
export function planBigQueryProfile(
    model: SemanticModel, options: ProfilePlanOptions = {}): ProfilePlan {
  const opts = resolveOptions(options);
  const p = new Planner(model, opts);
  p.keys();
  p.relationships();
  const constraints = p.constraints();
  p.units();
  p.regimes();
  constraints.required();
  return {
    model: model.name,
    options: opts,
    checks: p.checks,
    skipped: p.skipped,
    warnings: [...new Set(p.binder.warnings)],
  };
}

/** The plan's queries, each once, in plan order. */
export function distinctQueries(plan: ProfilePlan): string[] {
  return [...new Set(plan.checks.map(c => c.sql))];
}


// ---------------------------------------------------------------------------
// Evaluation: query rows -> statuses with evidence.
// ---------------------------------------------------------------------------

/** One query's row (column name -> cell, as BigQuery returns it) or error. */
export type QueryRow = Record<string, string|null>;
export type QueryOutcome = {row: QueryRow}|{error: string};

export interface ProfileFinding {
  id: string;
  kind: ProfileKind;
  entity: string;
  field?: string;
  statement: string;
  origin: 'model'|'SHACL'|'OWL';
  constraint?: string;
  status: ProfileStatus;
  // Why the statement has its status, in one line.
  summary: string;
  evidence: Record<string, unknown>;
  // Set when the query could not run (the status is then `unverified`).
  error?: string;
  sql: string;
}

interface Judgement {
  status: ProfileStatus;
  summary: string;
  evidence: Record<string, unknown>;
}

interface ValueCount {
  value: string;
  count: number;
}

function int(row: QueryRow, column: string): number {
  if (!(column in row)) throw new Error(`the result has no column '${column}'`);
  const v = row[column];
  if (v === null) return 0;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`column '${column}' is not a number`);
  return n;
}

function positive(row: QueryRow, column: string): number|undefined {
  const v = row[column];
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function jsonArray(row: QueryRow, column: string): unknown[] {
  const v = row[column];
  if (v === undefined || v === null) return [];
  const parsed = JSON.parse(v);
  if (parsed === null) return [];
  if (!Array.isArray(parsed)) throw new Error(`column '${column}' is not a JSON array`);
  return parsed;
}

function valueCounts(row: QueryRow, column: string): ValueCount[] {
  return jsonArray(row, column).map(x => {
    const o = (x ?? {}) as {value?: unknown; count?: unknown};
    return {value: String(o.value), count: Number(o.count)};
  });
}

function round(n: number, digits = 6): number {
  return Number(n.toFixed(digits));
}

function rate(part: number, whole: number): number {
  return whole ? round(part / whole) : 0;
}

function pct(part: number, whole: number): string {
  if (!whole || !part) return '0%';
  const p = (100 * part) / whole;
  return p < 0.01 ? '<0.01%' : `${Number(p.toFixed(2))}%`;
}

function fmt(n: number): string {
  return String(Number(n.toPrecision(4)));
}

function examplesText(top: ValueCount[]): string {
  return top.slice(0, 3).map(t => `'${t.value}' x${t.count}`).join(', ');
}

/**
 * The label of the window a regime query numbers `index`: its first month,
 * `YYYY-MM` (windows are `months` long, counted from year 0).
 */
export function windowLabel(index: number, months: number): string {
  const start = index * months;
  const year = Math.floor(start / 12);
  return `${String(year).padStart(4, '0')}-${String(start - year * 12 + 1).padStart(2, '0')}`;
}

function judgeKey(c: Extract<ProfileCheck, {kind: 'primaryKey'|'uniqueKey'}>, row: QueryRow): Judgement {
  const total = int(row, 'total');
  const nullKeys = int(row, 'null_keys');
  const distinctKeys = int(row, 'distinct_keys');
  const duplicateRows = Math.max(0, total - nullKeys - distinctKeys);
  const repeated = valueCounts(row, 'top_repeated');
  const evidence: Record<string, unknown> = {
    total,
    nullKeys,
    distinctKeys,
    duplicateRows,
    ...(repeated.length ? {repeatedKeys: repeated} : {}),
  };
  if (total === 0) return {status: 'unverified', summary: 'the table has no rows', evidence};
  const primary = c.kind === 'primaryKey';
  if (!primary && total === nullKeys) {
    return {
      status: 'unverified',
      summary: `no row sets every column of ${columnsLabel(c.keys)}`,
      evidence,
    };
  }
  const problems: string[] = [];
  if (primary && nullKeys) {
    problems.push(`${nullKeys} of ${total} row(s) (${pct(nullKeys, total)}) have a null key`);
  }
  if (duplicateRows) {
    problems.push(`${duplicateRows} row(s) (${pct(duplicateRows, total)}) repeat another row's key${
        repeated.length ? `, e.g. ${examplesText(repeated)}` : ''}`);
  }
  if (problems.length) return {status: 'contradicted', summary: problems.join('; '), evidence};
  return {
    status: 'verified',
    summary: `${total} row(s), ${distinctKeys} distinct key(s)${
        !primary && nullKeys ? ` (${nullKeys} row(s) with a null column not compared)` : ''}`,
    evidence,
  };
}

function judgeCardinality(c: Extract<ProfileCheck, {kind: 'cardinality'}>, row: QueryRow): Judgement {
  const fkRows = int(row, 'fk_rows');
  const fanoutRows = int(row, 'fanout_rows');
  const maxTargets = int(row, 'max_targets');
  const maxSources = int(row, 'max_sources');
  const observed = `${maxSources > 1 ? 'many' : 'one'}-to-${maxTargets > 1 ? 'many' : 'one'}`;
  const evidence: Record<string, unknown> = {
    declared: c.declared,
    observed,
    target: c.target,
    total: int(row, 'total'),
    fkRows,
    fanoutRows,
    maxTargetsPerRow: maxTargets,
    maxRowsPerTarget: maxSources,
  };
  if (!fkRows) {
    return {status: 'unverified', summary: `no ${c.entity} row sets the foreign key`, evidence};
  }
  if (fanoutRows) {
    return {
      status: 'contradicted',
      summary: `${fanoutRows} of ${fkRows} linked row(s) (${pct(fanoutRows, fkRows)}) reach more than one ${
          c.target} (up to ${maxTargets}): the referenced key repeats`,
      evidence,
    };
  }
  if (c.declared === 'one-to-one' && maxSources > 1) {
    return {
      status: 'contradicted',
      summary: `a row of ${c.target} is reached by up to ${maxSources} ${c.entity} rows`,
      evidence,
    };
  }
  return {
    status: 'verified',
    summary: `${fkRows} linked row(s), each reaching at most one ${c.target}${
        c.declared === 'one-to-one' ? `, each ${c.target} reached at most once` :
                                      ` (observed ${observed})`}`,
    evidence,
  };
}

function judgeOrphans(c: Extract<ProfileCheck, {kind: 'orphans'}>, row: QueryRow): Judgement {
  const fkRows = int(row, 'fk_rows');
  const orphanRows = int(row, 'orphan_rows');
  const orphanValues = int(row, 'orphan_values');
  const top = valueCounts(row, 'top_orphans');
  const evidence: Record<string, unknown> = {
    target: c.target,
    fkRows,
    orphanRows,
    orphanRate: rate(orphanRows, fkRows),
    orphanValues,
    ...(top.length ? {topOrphans: top} : {}),
  };
  if (!fkRows) {
    return {status: 'unverified', summary: `no ${c.entity} row sets the foreign key`, evidence};
  }
  if (orphanRows) {
    return {
      status: 'contradicted',
      summary: `${orphanRows} of ${fkRows} foreign-key value(s) (${pct(orphanRows, fkRows)}) match no ${
          c.target}; ${orphanValues} distinct${top.length ? `, e.g. ${examplesText(top)}` : ''}`,
      evidence,
    };
  }
  return {
    status: 'verified',
    summary: `all ${fkRows} foreign-key value(s) match a row of ${c.target}`,
    evidence,
  };
}

function judgeEnum(c: Extract<ProfileCheck, {kind: 'enumCoverage'}>, row: QueryRow): Judgement {
  const nonNull = int(row, 'non_null');
  const outsideRows = int(row, 'outside_rows');
  const top = valueCounts(row, 'top_outside');
  const used = new Set(jsonArray(row, 'used_values').map(String));
  const unused = c.values.filter(v => !used.has(v));
  const evidence: Record<string, unknown> = {
    declaredValues: c.values.length,
    total: int(row, 'total'),
    nonNull,
    outsideRows,
    outsideRate: rate(outsideRows, nonNull),
    outsideValues: int(row, 'outside_values'),
    ...(top.length ? {topOutside: top} : {}),
    ...(unused.length ? {unusedValues: unused.slice(0, 20), unusedCount: unused.length} : {}),
  };
  if (!nonNull) return {status: 'unverified', summary: 'no row sets the field', evidence};
  if (outsideRows) {
    return {
      status: 'contradicted',
      summary: `${outsideRows} of ${nonNull} value(s) (${pct(outsideRows, nonNull)}) are outside the declared set${
          top.length ? `, e.g. ${examplesText(top)}` : ''}`,
      evidence,
    };
  }
  return {
    status: 'verified',
    summary: `all ${nonNull} value(s) are in the declared set${
        unused.length ? `; ${unused.length} declared value(s) never occur` : ''}`,
    evidence,
  };
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function unitGroup(c: {unit: string; scale?: number}): string {
  return `${c.unit.trim().toLowerCase()}|${c.scale ?? 1}`;
}

function judgeUnit(
    c: Extract<ProfileCheck, {kind: 'unitMagnitude'}>, row: QueryRow,
    medians: Map<string, number>, plan: ProfilePlan): Judgement {
  const m = positive(row, `median_${c.slot}`);
  const label = unitLabel(c.unit, c.scale);
  const peers = plan.checks.filter(
      (p): p is Extract<ProfileCheck, {kind: 'unitMagnitude'}> => p.kind === 'unitMagnitude' &&
          p.id !== c.id && unitGroup(p) === unitGroup(c) && medians.has(p.id));
  const evidence: Record<string, unknown> = {
    unit: c.unit,
    ...(c.scale !== undefined ? {scale: c.scale} : {}),
    values: int(row, `values_${c.slot}`),
    ...(m !== undefined ? {median: m} : {}),
    peers: peers.length,
  };
  if (m === undefined) {
    return {status: 'unverified', summary: 'no non-zero value to measure', evidence};
  }
  if (!peers.length) {
    return {
      status: 'unverified',
      summary: `no other field of the model in ${label} to compare with`,
      evidence,
    };
  }
  const peerMedian = median(peers.map(p => medians.get(p.id)!));
  const orders = Math.log10(m / peerMedian);
  evidence.peerMedian = peerMedian;
  evidence.ordersOfMagnitude = round(orders, 2);
  evidence.peerFields = peers.slice(0, 10).map(p => `${p.entity}.${p.field}`);
  const ratio = Math.pow(10, Math.abs(orders));
  if (Math.abs(orders) >= plan.options.magnitudeOrders) {
    return {
      status: 'unverified',
      summary: `median |value| ${fmt(m)} is x${fmt(ratio)} ${orders > 0 ? 'above' : 'below'} the median of ${
          peers.length} other ${label} field(s) (${fmt(peerMedian)}): possible scale mismatch`,
      evidence,
    };
  }
  return {
    status: 'verified',
    summary: `median |value| ${fmt(m)}, within x${fmt(ratio)} of the median of ${
        peers.length} other ${label} field(s) (${fmt(peerMedian)})`,
    evidence,
  };
}

function judgeRegime(
    c: Extract<ProfileCheck, {kind: 'regimeShift'}>, row: QueryRow,
    options: ResolvedProfileOptions): Judgement {
  const months = options.windowMonths;
  const windows = jsonArray(row, 'series')
                      .map(x => x as Record<string, unknown>)
                      .map(w => ({
                             from: windowLabel(Number(w.w), months),
                             n: Number(w[`n${c.slot}`] ?? 0),
                             m: Number(w[`m${c.slot}`] ?? 0),
                           }))
                      .filter(w => w.n >= options.minWindowRows && Number.isFinite(w.m) && w.m > 0);
  const shifts: Array<{from: string; to: string; before: number; after: number; ratio: number}> = [];
  let maxRatio = 1;
  for (let i = 1; i < windows.length; i++) {
    const a = windows[i - 1];
    const b = windows[i];
    const r = Math.max(a.m, b.m) / Math.min(a.m, b.m);
    maxRatio = Math.max(maxRatio, r);
    if (r >= options.shiftFactor) {
      shifts.push({from: a.from, to: b.from, before: a.m, after: b.m, ratio: round(r, 2)});
    }
  }
  const evidence: Record<string, unknown> = {
    timeField: c.timeField,
    timeFieldFrom: c.timeFieldFrom,
    windowMonths: months,
    windows: windows.length,
    ...(windows.length ? {span: {from: windows[0].from, to: windows[windows.length - 1].from}} : {}),
    maxRatio: round(maxRatio, 2),
    ...(shifts.length ? {shifts: shifts.slice(0, 10)} : {}),
    ...(c.regime ? {regime: c.regime} : {}),
  };
  if (windows.length < 2) {
    return {
      status: 'unverified',
      summary: `fewer than two ${months}-month windows with at least ${
          options.minWindowRows} non-zero values`,
      evidence,
    };
  }
  if (!shifts.length) {
    return {
      status: 'verified',
      summary: `${windows.length} windows of ${months} month${
          months === 1 ? '' : 's'}; neighbouring medians stay within x${fmt(maxRatio)}`,
      evidence,
    };
  }
  const s = shifts[0];
  const at = `x${fmt(s.ratio)} from ${fmt(s.before)} (${s.from}) to ${fmt(s.after)} (${s.to})`;
  if (c.regime) {
    return {
      status: 'verified',
      summary: `the median changes ${at}, as the declared regime says: ${c.regime}`,
      evidence,
    };
  }
  return {
    status: 'contradicted',
    summary: `the median jumps ${at}${
        shifts.length > 1 ? ` (${shifts.length} breaks)` : ''}; no regime is declared`,
    evidence,
  };
}

function judgeRequired(c: Extract<ProfileCheck, {kind: 'requiredNulls'}>, row: QueryRow): Judgement {
  const total = int(row, 'total');
  const nulls = int(row, `nulls_${c.slot}`);
  const evidence = {total, nulls, nullRate: rate(nulls, total)};
  if (!total) return {status: 'unverified', summary: `no ${c.entity} rows`, evidence};
  if (nulls) {
    return {
      status: 'contradicted',
      summary: `${nulls} of ${total} row(s) (${pct(nulls, total)}) have no value`,
      evidence,
    };
  }
  return {status: 'verified', summary: `all ${total} row(s) have a value`, evidence};
}

function judge(
    c: ProfileCheck, row: QueryRow, plan: ProfilePlan,
    medians: Map<string, number>): Judgement {
  switch (c.kind) {
    case 'primaryKey':
    case 'uniqueKey':
      return judgeKey(c, row);
    case 'cardinality':
      return judgeCardinality(c, row);
    case 'orphans':
      return judgeOrphans(c, row);
    case 'enumCoverage':
      return judgeEnum(c, row);
    case 'unitMagnitude':
      return judgeUnit(c, row, medians, plan);
    case 'regimeShift':
      return judgeRegime(c, row, plan.options);
    case 'requiredNulls':
      return judgeRequired(c, row);
  }
}

/**
 * Settles every statement of `plan` from the rows its queries returned
 * (`outcomes`, keyed by SQL text). A query that failed -- or was not run --
 * leaves its statements `unverified`, with the error.
 */
export function evaluateProfile(
    plan: ProfilePlan, outcomes: ReadonlyMap<string, QueryOutcome>): ProfileFinding[] {
  // A unit statement is judged against its peers, so every median first.
  const medians = new Map<string, number>();
  for (const c of plan.checks) {
    if (c.kind !== 'unitMagnitude') continue;
    const out = outcomes.get(c.sql);
    const m = out && 'row' in out ? positive(out.row, `median_${c.slot}`) : undefined;
    if (m !== undefined) medians.set(c.id, m);
  }
  return plan.checks.map((c): ProfileFinding => {
    const base = {
      id: c.id,
      kind: c.kind,
      entity: c.entity,
      ...(c.field !== undefined ? {field: c.field} : {}),
      statement: c.statement,
      origin: c.origin,
      ...(c.constraint ? {constraint: c.constraint} : {}),
    };
    const out = outcomes.get(c.sql);
    if (!out) {
      return {...base, status: 'unverified', summary: 'not run', evidence: {}, sql: c.sql};
    }
    if ('error' in out) {
      return {
        ...base,
        status: 'unverified',
        summary: `the query failed: ${out.error.split('\n')[0]}`,
        evidence: {},
        error: out.error,
        sql: c.sql,
      };
    }
    try {
      return {...base, ...judge(c, out.row, plan, medians), sql: c.sql};
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ...base,
        status: 'unverified',
        summary: `unreadable result: ${message}`,
        evidence: {},
        error: message,
        sql: c.sql,
      };
    }
  });
}


// ---------------------------------------------------------------------------
// Reports: the .sql file, profile.json, profile.md and the console table.
// ---------------------------------------------------------------------------

export interface ProfileMeta {
  profile: string;
  checkedAt?: string;
}

/** The plan's queries as one runnable .sql file, each once, statements first. */
export function renderProfileSql(plan: ProfilePlan, meta: ProfileMeta): string {
  const out = [
    `-- Generated by kcmd profile for model '${plan.model}' (profile '${meta.profile}').`,
    `-- Each query returns one row; the statements it settles are listed above it.`,
    `-- Read-only: nothing here writes, and the results are a report, never a filter.`,
  ];
  for (const s of plan.skipped) {
    out.push(`-- skipped ${s.subject}: ${s.reason.replace(/\n/g, ' ')}`);
  }
  for (const sql of distinctQueries(plan)) {
    out.push('');
    for (const c of plan.checks.filter(x => x.sql === sql)) {
      out.push(`-- [${c.id}] ${c.kind}: ${c.statement}`);
    }
    out.push(`${sql};`);
  }
  return out.join('\n') + '\n';
}

export interface ProfileReport {
  model: string;
  profile: string;
  checkedAt: string;
  options: ResolvedProfileOptions;
  summary: Record<ProfileStatus, number>;
  statements: ProfileFinding[];
  skipped: SkippedStatement[];
  warnings: string[];
}

export function countStatuses(findings: ProfileFinding[]): Record<ProfileStatus, number> {
  const out: Record<ProfileStatus, number> = {verified: 0, unverified: 0, contradicted: 0};
  for (const f of findings) out[f.status]++;
  return out;
}

/** The JSON report of one model (an element of profile.json's `models`). */
export function profileReport(
    plan: ProfilePlan, findings: ProfileFinding[],
    meta: {profile: string; checkedAt: string}): ProfileReport {
  return {
    model: plan.model,
    profile: meta.profile,
    checkedAt: meta.checkedAt,
    options: plan.options,
    summary: countStatuses(findings),
    statements: findings,
    skipped: plan.skipped,
    warnings: plan.warnings,
  };
}

const STATUS_RANK: Record<ProfileStatus, number> = {contradicted: 0, unverified: 1, verified: 2};

function bySeverity(findings: ProfileFinding[]): ProfileFinding[] {
  return findings.map((f, i) => ({f, i}))
      .sort((a, b) => STATUS_RANK[a.f.status] - STATUS_RANK[b.f.status] || a.i - b.i)
      .map(x => x.f);
}

function subjectOf(f: ProfileFinding): string {
  if (f.field === undefined) return f.entity;
  return f.kind === 'primaryKey' || f.kind === 'uniqueKey' ? `${f.entity}(${f.field})` :
                                                             `${f.entity}.${f.field}`;
}

function summaryLine(counts: Record<ProfileStatus, number>): string {
  const total = counts.verified + counts.unverified + counts.contradicted;
  return `${total} statement(s): ${counts.verified} verified, ${counts.unverified} unverified, ${
      counts.contradicted} contradicted`;
}

function cell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** profile.md: per model, a summary line and a table, worst status first. */
export function renderProfileMarkdown(reports: ProfileReport[]): string {
  const out = ['# Data profile', ''];
  for (const r of reports) {
    out.push(`## Model \`${r.model}\``, '',
             `Binding profile \`${r.profile}\`, checked ${r.checkedAt}: ${summaryLine(r.summary)}.`, '',
             '| Status | Kind | Subject | Statement | Evidence |',
             '|--------|------|---------|-----------|----------|');
    for (const f of bySeverity(r.statements)) {
      out.push(`| ${f.status} | ${f.kind} | ${cell(subjectOf(f))} | ${cell(f.statement)} | ${
          cell(f.summary)} |`);
    }
    if (r.skipped.length) {
      out.push('', 'Not profiled:', '');
      for (const s of r.skipped) out.push(`- ${s.subject}: ${s.reason}`);
    }
    out.push('');
  }
  return out.join('\n');
}

/** The console table: status, kind, subject, summary; then the totals. */
export function formatProfileTable(findings: ProfileFinding[]): string {
  const sorted = bySeverity(findings);
  const rows = sorted.map(f => [f.status, f.kind, subjectOf(f), f.summary]);
  const head = ['STATUS', 'KIND', 'SUBJECT', 'SUMMARY'];
  const width = [0, 1, 2].map(i => Math.max(head[i].length, ...rows.map(r => r[i].length)));
  const line = (r: string[]) =>
      r.map((c, i) => (i < 3 ? c.padEnd(width[i]) : c)).join('  ').trimEnd();
  return [line(head), ...rows.map(line), '', summaryLine(countStatuses(findings))].join('\n');
}


// ---------------------------------------------------------------------------
// The Knowledge Catalog aspect.
// ---------------------------------------------------------------------------

export const PROFILE_RESULTS_TYPE_ID = 'semantic-profile-results';

// Aspect-only, like semantic-constraint-results (validate_bigquery.ts): it
// rides the built-in `semantic-entity` entries and is created on first
// publish at `<project>/global`. Append-only template: never renumber.
export const PROFILE_RESULTS_ASPECT_TYPE: Omit<AspectType, 'name'> = {
  displayName: 'Semantic Profile Results',
  description:
      'The last measured state of the data behind the semantic model\'s ' +
      'claims about this entity (keys, relationship cardinality, value sets, ' +
      'units, stability over time, required fields): one statement per claim, ' +
      'verified, unverified or contradicted, with the evidence and the query ' +
      'that produced it. A report, never a filter.',
  metadataTemplate: {
    name: PROFILE_RESULTS_TYPE_ID,
    type: 'record',
    recordFields: [
      {index: 1, name: 'model', type: 'string', annotations: {displayName: 'Model'}},
      {index: 2, name: 'profile', type: 'string', annotations: {displayName: 'Binding Profile', description: 'The binding profile whose tables were profiled.'}},
      {index: 3, name: 'checkedAt', type: 'string', annotations: {displayName: 'Checked At', description: 'When the run that wrote this aspect finished (RFC 3339).'}},
      {index: 4, name: 'verified', type: 'int', annotations: {displayName: 'Verified'}},
      {index: 5, name: 'unverified', type: 'int', annotations: {displayName: 'Unverified'}},
      {index: 6, name: 'contradicted', type: 'int', annotations: {displayName: 'Contradicted'}},
      {
        index: 7,
        name: 'statements',
        type: 'array',
        arrayItems: {
          name: 'statement',
          type: 'record',
          recordFields: [
            {index: 1, name: 'statement', type: 'string', constraints: {required: true}, annotations: {displayName: 'Statement', description: 'The model\'s claim, in words.'}},
            {index: 2, name: 'kind', type: 'string', annotations: {displayName: 'Kind', description: 'primaryKey, uniqueKey, cardinality, orphans, enumCoverage, unitMagnitude, regimeShift or requiredNulls.'}},
            {index: 3, name: 'field', type: 'string', annotations: {displayName: 'Field', description: 'The field, key columns or relationship the statement is about.'}},
            {index: 4, name: 'status', type: 'string', annotations: {displayName: 'Status', description: '`verified`, `unverified` or `contradicted`.'}},
            {index: 5, name: 'summary', type: 'string', annotations: {displayName: 'Summary', description: 'Why the statement has its status.'}},
            {index: 6, name: 'evidence', type: 'string', annotations: {displayName: 'Evidence', description: 'The measured counts, rates and examples, as JSON.'}},
            {index: 7, name: 'sql', type: 'string', annotations: {displayName: 'SQL', description: 'The query that produced the evidence.'}},
            {index: 8, name: 'error', type: 'string', annotations: {displayName: 'Error', description: 'Why the query could not run, when it could not.'}},
            {index: 9, name: 'constraint', type: 'string', annotations: {displayName: 'Constraint', description: 'The constraint the claim comes from, when it does.'}},
            {index: 10, name: 'id', type: 'string', annotations: {displayName: 'Id'}},
          ],
        },
        annotations: {displayName: 'Statements', description: 'One record per statement profiled on this entity.'},
      },
      {index: 8, name: 'sqlOmitted', type: 'bool', annotations: {displayName: 'SQL Omitted', description: 'True when the queries were left out to keep the aspect under its size limit.'}},
    ],
  },
};

// Aspect data is capped (about 120 KB); past this budget the SQL is dropped.
const PROFILE_ASPECT_BUDGET = 100_000;

export function profileAspectKey(dest: {project: string}): string {
  return `${dest.project}.global.${PROFILE_RESULTS_TYPE_ID}`;
}
export function profileAspectTypeName(dest: {project: string}): string {
  return `projects/${dest.project}/locations/global/aspectTypes/${PROFILE_RESULTS_TYPE_ID}`;
}

/** One statement as published in the aspect. */
export function profileStatementPayload(f: ProfileFinding, withSql = true): Record<string, any> {
  const out: Record<string, any> = {
    id: f.id,
    statement: f.statement,
    kind: f.kind,
    status: f.status,
    summary: f.summary,
    evidence: JSON.stringify(f.evidence),
  };
  if (f.field !== undefined) out.field = f.field;
  if (f.constraint) out.constraint = f.constraint;
  if (withSql) out.sql = f.sql;
  if (f.error !== undefined) out.error = f.error;
  return out;
}

/**
 * The entry updates that publish `findings`: one per entity, each carrying
 * only the profile aspect (the update names just that aspect key, so the
 * entry's other aspects are untouched).
 */
export function profileResultsUpdates(
    findings: ProfileFinding[], dest: KcDestination,
    meta: {model: string; profile: string; checkedAt: string}): Entry[] {
  const byEntity = new Map<string, ProfileFinding[]>();
  for (const f of findings) byEntity.set(f.entity, [...(byEntity.get(f.entity) ?? []), f]);
  return [...byEntity.entries()].map(([entity, fs]) => {
    const counts = countStatuses(fs);
    const data: Record<string, any> = {
      model: meta.model,
      profile: meta.profile,
      checkedAt: meta.checkedAt,
      ...counts,
      statements: fs.map(f => profileStatementPayload(f)),
    };
    if (JSON.stringify(data).length > PROFILE_ASPECT_BUDGET) {
      data.statements = fs.map(f => profileStatementPayload(f, false));
      data.sqlOmitted = true;
    }
    return {
      name: entityEntryName(dest, meta.model, entity),
      entryType: 'projects/dataplex-types/locations/global/entryTypes/semantic-entity',
      aspects: {
        [profileAspectKey(dest)]: {aspectType: profileAspectTypeName(dest), data},
      },
    };
  });
}


// ---------------------------------------------------------------------------
// Running (network).
// ---------------------------------------------------------------------------

export interface ProfileRunOptions {
  // Project the query jobs run (and bill) in. Defaults to ctx.project.
  project?: string;
  // BigQuery processing location (e.g. US). Inferred from the tables when unset.
  location?: string;
  // Labels attached to every query job.
  labels?: Record<string, string>;
  concurrency?: number;
  maxPolls?: number;
}

/** The first row of a query response, by column name. */
export function firstRow(res: QueryResponse): QueryRow|undefined {
  const names: string[] = (res.schema?.fields ?? []).map((f: {name: string}) => f.name);
  const first = (res.rows ?? [])[0] as {f: {v: unknown}[]}|undefined;
  if (!first) return undefined;
  const row: QueryRow = {};
  first.f.forEach((c, i) => {
    row[names[i] ?? `f${i}`] = c.v === null || c.v === undefined ? null : String(c.v);
  });
  return row;
}

/**
 * `--label key:value` values as BigQuery job labels, or the first malformed
 * one. Keys start with a lowercase letter; keys and values use lowercase
 * letters, digits, `_` and `-` (at most 63 characters).
 */
export function parseJobLabels(raw: string|string[]|undefined):
    {labels: Record<string, string>}|{error: string} {
  const items = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const labels: Record<string, string> = {};
  for (const item of items) {
    const s = String(item);
    const at = s.indexOf(':');
    const key = at < 0 ? s : s.slice(0, at);
    const value = at < 0 ? '' : s.slice(at + 1);
    if (at < 0 || !/^[a-z][a-z0-9_-]{0,62}$/.test(key) || !/^[a-z0-9_-]{0,63}$/.test(value)) {
      return {
        error: `--label must be key:value with lowercase letters, digits, '_' or '-'; got '${s}'`,
      };
    }
    labels[key] = value;
  }
  return {labels};
}

/** Runs one query that returns one row (polling until the job completes). */
export async function runProfileQuery(
    client: BigQueryClient, project: string, sql: string,
    options: ProfileRunOptions): Promise<QueryOutcome> {
  const started = await client.query(project, sql, options.location, false,
                                     undefined, options.labels);
  if (started.status !== 200 || !started.result) {
    return {error: errorText(started.message, started.status)};
  }
  let res: QueryResponse = started.result;
  const jobId = res.jobReference?.jobId;
  const loc = res.jobReference?.location ?? options.location;
  const maxPolls = options.maxPolls ?? 60;
  for (let polls = 0; res.jobComplete === false && jobId && polls < maxPolls; polls++) {
    const next: ApiResult<QueryResponse> =
        await client.getQueryResults(project, jobId, loc, 10);
    if (next.status !== 200 || !next.result) {
      return {error: errorText(next.message, next.status)};
    }
    res = next.result;
  }
  if (res.jobComplete === false) return {error: `job ${jobId} did not complete`};
  const row = firstRow(res);
  if (!row) {
    return {
      error: res.errors?.length ? res.errors.map(e => e.message).join('; ') : 'no result row',
    };
  }
  return {row};
}

/** Runs each of the plan's queries once; outcomes are keyed by SQL text. */
export async function runBigQueryProfile(
    plan: ProfilePlan, ctx: context.ApiContext,
    options: ProfileRunOptions = {}): Promise<Map<string, QueryOutcome>> {
  const client = new BigQueryClient(ctx);
  const project = options.project ?? ctx.project;
  const queries = distinctQueries(plan);
  const outcomes = new Map<string, QueryOutcome>();
  let next = 0;
  const worker = async () => {
    while (next < queries.length) {
      const sql = queries[next++];
      outcomes.set(sql, await runProfileQuery(client, project, sql, options));
    }
  };
  await Promise.all(Array.from(
      {length: Math.max(1, Math.min(options.concurrency ?? 6, queries.length))}, worker));
  return outcomes;
}


// ---------------------------------------------------------------------------
// Publishing (network, unless dry-run).
// ---------------------------------------------------------------------------

export interface PublishProfileOptions {
  // Print the requests instead of sending them.
  dryRun?: boolean;
  log?: (line: string) => void;
}

/**
 * Writes the statements to Knowledge Catalog: the profile aspect on each
 * profiled entity's entry (published by `kcmd push`), creating the aspect
 * type on first use. Only that aspect is named in each update, so nothing
 * else on the entry changes. With `dryRun` the requests are printed and
 * nothing is sent.
 */
export async function publishProfileResults(
    findings: ProfileFinding[], ctx: context.ApiContext, dest: KcDestination,
    meta: {model: string; profile: string; checkedAt: string},
    options: PublishProfileOptions = {}):
    Promise<{published: string[]; planned: string[]; errors: string[]}> {
  const log = options.log ?? ((l: string) => console.log(l));
  const updates = profileResultsUpdates(findings, dest, meta);
  const key = profileAspectKey(dest);
  if (options.dryRun) {
    log(`POST projects/${dest.project}/locations/global/aspectTypes?aspectTypeId=${
        PROFILE_RESULTS_TYPE_ID}  (only when the aspect type does not exist yet)`);
    log(JSON.stringify(PROFILE_RESULTS_ASPECT_TYPE, null, 2));
    for (const u of updates) {
      log(`PATCH ${u.name}?${new URLSearchParams({updateMask: 'aspects', aspectKeys: key})}`);
      log(JSON.stringify(u, null, 2));
    }
    return {published: [], planned: updates.map(u => u.name), errors: []};
  }
  const cat = new CatalogClient(ctx);
  const created = await cat.createAspectType(
      dest.project, 'global', PROFILE_RESULTS_TYPE_ID, PROFILE_RESULTS_ASPECT_TYPE);
  if (created.status !== 200 && created.status !== 409) {
    return {
      published: [],
      planned: [],
      errors: [`creating aspect type '${PROFILE_RESULTS_TYPE_ID}' in project '${
          dest.project}': ${errorText(created.message, created.status)}`],
    };
  }
  if (created.status === 200) {
    const failed = await cat.awaitOperation(
        created.result, `creating aspect type '${PROFILE_RESULTS_TYPE_ID}'`);
    if (failed) return {published: [], planned: [], errors: [failed]};
  }
  const published: string[] = [];
  const errors: string[] = [];
  for (const entry of updates) {
    const res = await cat.updateEntry(entry, ['aspects'], [key]);
    if (res.status === 200) {
      published.push(entry.name);
    } else {
      errors.push(`${entry.name.split('/').pop()}: ${
          res.status === 404 ? 'no such entry (run `kcmd push` first)' :
                               errorText(res.message, res.status)}`);
    }
  }
  return {published, planned: [], errors};
}
