// Consumption-time constraint enforcement: the node view applies the model's
// constraints to the rows it serves (see ir.EntityHydration.constraints).
//
// A binding profile opts an entity in with one hydration rule:
//
//   hydration:
//     grain: { deterministic: true }
//     constraints: enforce
//
// and the entity's node view (node_views.ts) then routes every rule it can
// check deterministically -- the SHACL / OWL rules `kcmd validate` checks,
// parsed and compiled by the same code (validate_bigquery.ts) -- on the rule's
// `on_violation` word, after the other hydration rules:
//
//   - `reject`, about a value (a pattern, an allowed set, a range, a length, a
//     comparison with another field, an empty field): the failing value is
//     withheld (served as NULL) and the row is kept.
//   - `reject`, about the record itself (a required field, or any rule on a
//     key field): the row is excluded.
//   - `warn` / `escalate`: the row is served as it is. A read has no approver
//     to escalate to.
//   - Every rule a served row breaks -- a withheld value's included -- is
//     named in the view's `_warnings` column (ARRAY<STRING>, empty when the row
//     breaks none).
//   - An allowed set (sh:in) also repairs spelling: a value equal to a member
//     once case and whitespace are ignored is served in the member's spelling
//     ('COMPETITIVE PRESSURE' -> 'Competitive Pressure'), and only a value
//     matching no member breaks the rule. A spelling two members share is left
//     as recorded.
//   - Relationship rules (cardinality, edge targets) and class disjointness are
//     reported, never applied: excluding a record for a missing or extra edge
//     would cascade across entities.
//
// A rule on a supertype applies to the entity's rows; a rule on a defined
// entity applies to the base's rows its membership predicate selects. Every
// rule is evaluated on the same hydrated (and spelling-repaired) row, so one
// rule's outcome never feeds another's.
//
// The view is three steps:
//
//   WITH hydrated AS (<the hydration SELECT>),
//   checked AS (SELECT h.*, COALESCE(<rule 0 broken>, FALSE) AS _kcmd_c0, ...
//               FROM hydrated AS h)
//   SELECT c.pricing_id, IF(c._kcmd_c1, NULL, c.floor_price) AS floor_price,
//          ..., ARRAY(<names of the broken rules>) AS _warnings
//   FROM checked AS c
//   WHERE NOT (c._kcmd_c0)                       -- record-level reject rules
//
// and push measures each rule over the same `checked` rows (ratesSql), so the
// entity's catalog entry can say how often each rule breaks (a `Constraints:`
// paragraph; see constraintsTrailer).
//
// Layering: everything above `measureConstraintRates` is pure and unit-tested
// without a network.

import {BigQueryClient} from '../gcp/bigquery';
import * as context from '../gcp/context';

import {membershipFieldRefs, resolveDefinedEntities} from './defined_entities';
import {aliased, sqlString} from './generated_views';
import {DataType, Entity, SemanticModel} from './ir';
import {rewriteFieldRefs} from './sql_expr_utils';
import {quoteIfReserved} from './sql_identifiers';
import {CheckKind, ConstraintSpec, FieldSpec, fieldViolation, isFieldSpec, parseConstraintSpec, planBigQueryValidation, runBigQueryValidation, runQuery, Unsupported} from './validate_bigquery';

/** What an enforcing node view does with a row that breaks a rule. */
export type EnforcementEffect = 'exclude'|'withhold'|'flag'|'report';

/** One rule as an entity's node view applies it. */
export interface EnforcedRule {
  // The constraint's name: what `_warnings` and the catalog paragraph name.
  constraint: string;
  effect: EnforcementEffect;
  kind: CheckKind;
  // A field rule's constrained field (the one withheld under `withhold`).
  field?: string;
  // A defined entity's rule: applies to the rows its membership selects.
  gate?: {entity: string; membership: string};
  spec: ConstraintSpec;
}

/** The rules one entity's node view applies, and the spellings it repairs. */
export interface EnforcementPlan {
  entity: string;
  rules: EnforcedRule[];
  // Allowed-set rules on text fields: the members to repair spelling to.
  repairs: {field: string; members: string[]}[];
  // Rules about this entity the view cannot check, with the reason.
  skipped: {constraint: string; reason: string}[];
}

/** The rules of a plan the view evaluates per row (all but `report`). */
export function rowRules(plan: EnforcementPlan): EnforcedRule[] {
  return plan.rules.filter(r => r.effect !== 'report');
}

function lineage(model: SemanticModel, name: string): string[] {
  const byName = new Map((model.entities ?? []).map(e => [e.name, e]));
  const out: string[] = [];
  const queue = [name];
  while (queue.length) {
    const n = queue.shift()!;
    if (out.includes(n)) continue;
    out.push(n);
    queue.push(...(byName.get(n)?.extends ?? []));
  }
  return out;
}

const textual = (t: DataType|undefined) => t === undefined || t === 'String';

/**
 * The rules `entity`'s node view applies (see the file header). `resolved` is
 * the entity with inheritance flattened; `bound` says which fields its view
 * has a column for. Rules are kept in model order; a rule this entity's rows
 * are subject to but the view cannot check is listed in `skipped`.
 */
export function planEnforcement(
    model: SemanticModel, resolved: Entity,
    bound: (field: string) => boolean): EnforcementPlan {
  const name = resolved.name;
  const mine = lineage(model, name);
  const defined = resolveDefinedEntities(model).infos;
  const typeOf = (f: string) => resolved.fields.find(x => x.name === f)?.type;
  const plan: EnforcementPlan = {entity: name, rules: [], repairs: [], skipped: []};

  for (const c of model.constraints ?? []) {
    const parsed = parseConstraintSpec(c, model);
    if ('unsupported' in parsed) continue;  // validate reports these
    const spec = parsed.spec;
    let gate: EnforcedRule['gate'];
    const info = defined.get(spec.entity);
    if (!mine.includes(spec.entity)) {
      if (!info || !mine.includes(info.base)) continue;
      gate = {entity: spec.entity, membership: info.membership};
    }

    if (!isFieldSpec(spec)) {
      // Reported on the entity the rule names (or a defined entity's base),
      // not on every subtype: the rate is measured over that entity's rows.
      const home = info ? info.base : spec.entity;
      if (home !== name) continue;
      // Only what the validation queries can measure is reported.
      const check = planBigQueryValidation(
          {...model, constraints: [c]}, {structural: false, examples: 0});
      if (!check.checks.length) {
        plan.skipped.push({
          constraint: c.name,
          reason: check.unsupported[0]?.reason ?? 'no query measures it',
        });
        continue;
      }
      plan.rules.push({constraint: c.name, effect: 'report', kind: spec.kind, spec});
      continue;
    }

    const needed = [
      spec.field,
      ...('other' in spec ? [spec.other] : []),
      ...(gate ? membershipFields(gate.membership, resolved) : []),
    ];
    const missing = [...new Set(needed.filter(f => !bound(f)))];
    if (missing.length) {
      plan.skipped.push({
        constraint: c.name,
        reason: `${missing.map(f => `'${f}'`).join(', ')} ${
            missing.length === 1 ? 'is' : 'are'} not bound on '${name}'`,
      });
      continue;
    }
    try {
      fieldViolation(spec, f => f, typeOf(spec.field));
    } catch (err) {
      if (!(err instanceof Unsupported)) throw err;
      plan.skipped.push({constraint: c.name, reason: err.message});
      continue;
    }
    const reject = c.onViolation === 'reject';
    const effect: EnforcementEffect = !reject ? 'flag' :
        spec.kind === 'required' || resolved.keys.includes(spec.field) ?
                                                'exclude' :
                                                'withhold';
    plan.rules.push({
      constraint: c.name,
      effect,
      kind: spec.kind,
      field: spec.field,
      ...(gate ? {gate} : {}),
      spec,
    });
    if (spec.kind === 'in' && textual(typeOf(spec.field))) {
      plan.repairs.push({field: spec.field, members: spec.values});
    }
  }
  return plan;
}

// The fields of `entity` a membership predicate reads.
function membershipFields(membership: string, entity: Entity): string[] {
  const names = new Set(entity.fields.map(f => f.name));
  return membershipFieldRefs(membership).filter(n => names.has(n));
}


// ---------------------------------------------------------------------------
// SQL.
// ---------------------------------------------------------------------------

// RE2's `\s` (ASCII whitespace), the class the view strips; the JavaScript
// side must strip the same characters to build matching keys.
const ASCII_SPACE = /[\t\n\f\r ]/g;

/** A member's spelling key: lower case, whitespace removed. */
export function spellingKey(value: string): string {
  return value.toLowerCase().replace(ASCII_SPACE, '');
}

/**
 * `expr` with its spelling repaired to `members` (see the file header): a
 * CASE over the value's spelling key. A key two different members share is
 * left out (the value stays as recorded). `expr` unchanged when no member has
 * a key of its own.
 */
export function repairSql(expr: string, members: string[]): string {
  const byKey = new Map<string, Set<string>>();
  for (const m of members) {
    const k = spellingKey(m);
    byKey.set(k, (byKey.get(k) ?? new Set()).add(m));
  }
  const whens = [...byKey.entries()]
                    .filter(([, ms]) => ms.size === 1)
                    .map(([k, ms]) => `WHEN ${sqlString(k)} THEN ${
                             sqlString([...ms][0])}`);
  if (!whens.length) return expr;
  return `CASE LOWER(REGEXP_REPLACE(CAST(${expr} AS STRING), r'\\s', '')) ${
      whens.join(' ')} ELSE ${expr} END`;
}

function indentLines(lines: string[], by = '  '): string[] {
  return lines.join('\n').split('\n').map(l => `${by}${l}`);
}

/** The flag column of a plan's i-th row rule. */
export function flagColumn(i: number): string {
  return `_kcmd_c${i}`;
}

/** The column that names the rules a served row breaks. */
export const WARNINGS_COLUMN = '_warnings';

/**
 * The enforcing view body around the hydration SELECT (`hydrated`, as lines):
 * the `checked` step with one flag per row rule, then the served columns, the
 * `_warnings` column and the exclusions. `columns` maps each bound field to its
 * view column, in output order; `typeOf` gives a field's type. Also returns
 * the query that counts each rule's breaks over the same rows (`ratesSql`;
 * columns `total` and one per rule, named as the flag). Undefined when the
 * plan has no row rule (the view stays as hydrated).
 */
export function enforcedViewSql(
    hydrated: string[], plan: EnforcementPlan, columns: Map<string, string>,
    typeOf: (field: string) => DataType | undefined):
    {body: string[]; ratesSql: string}|undefined {
  const rules = rowRules(plan);
  if (!rules.length) return undefined;
  const at = (alias: string) => (field: string) =>
      aliased(alias, columns.get(field)!);
  const fieldRefs = new Map([...columns.entries()].map(
      ([f, col]) => [f, aliased('h', col)] as [string, string]));
  const flags = rules.map((r, i) => {
    const broken = fieldViolation(r.spec as FieldSpec, at('h'), typeOf(r.field!));
    const gated = r.gate ?
        `(${rewriteFieldRefs(r.gate.membership, fieldRefs)}) AND (${broken})` :
        broken;
    return `COALESCE(${gated}, FALSE) AS ${flagColumn(i)}`;
  });
  const ctes = [
    'WITH hydrated AS (',
    ...indentLines(hydrated),
    '),',
    'checked AS (',
    '  SELECT',
    `    h.*,`,
    flags.map(f => `    ${f}`).join(',\n'),
    '  FROM hydrated AS h',
    ')',
  ];

  const c = at('c');
  const served = [...columns.entries()].map(([field, col]) => {
    const withheld = rules.map((r, i) => ({r, i}))
                         .filter(({r}) => r.effect === 'withhold' && r.field === field)
                         .map(({i}) => `c.${flagColumn(i)}`);
    return withheld.length ?
        `IF(${withheld.join(' OR ')}, NULL, ${c(field)}) AS ${quoteIfReserved(col)}` :
        c(field);
  });
  const named = rules.map((r, i) => ({r, i})).filter(({r}) => r.effect !== 'exclude');
  const warnings = named.length ?
      [
        `ARRAY(SELECT w.rule FROM UNNEST([`,
        named.map(({r, i}, n) => n === 0 ?
                      `    STRUCT(c.${flagColumn(i)} AS broken, ${sqlString(r.constraint)} AS rule)` :
                      `    STRUCT(c.${flagColumn(i)}, ${sqlString(r.constraint)})`)
            .join(',\n'),
        `  ]) AS w WITH OFFSET AS o WHERE w.broken ORDER BY o) AS ${WARNINGS_COLUMN}`,
      ].join('\n') :
      `ARRAY<STRING>[] AS ${WARNINGS_COLUMN}`;
  const excluded = rules.map((r, i) => ({r, i}))
                       .filter(({r}) => r.effect === 'exclude')
                       .map(({i}) => `c.${flagColumn(i)}`);
  const body = [
    ...ctes,
    'SELECT',
    [...served, warnings].map(s => indentLines([s]).join('\n')).join(',\n'),
    'FROM checked AS c',
    ...(excluded.length ? [`WHERE NOT (${excluded.join(' OR ')})`] : []),
  ];
  const ratesSql = [
    ...ctes,
    'SELECT',
    [
      '  COUNT(*) AS total',
      ...rules.map((_, i) => `  COUNTIF(${flagColumn(i)}) AS ${flagColumn(i)}`),
    ].join(',\n'),
    'FROM checked',
  ].join('\n');
  return {body, ratesSql};
}


// ---------------------------------------------------------------------------
// Words: the view description and the catalog paragraph.
// ---------------------------------------------------------------------------

/** How often one rule breaks over the rows it is checked on. */
export interface RuleRate {
  violations: number;
  total: number;
}

/** Per entity, per constraint: the measured rates (see measureConstraintRates). */
export type ConstraintRates = Map<string, Map<string, RuleRate>>;

/** The prefix of an entity's constraints paragraph. */
export const CONSTRAINTS_PREFIX = 'Constraints: ';

const LEAD = 'enforced in the node view after hydration; each rule a served ' +
    `row breaks is named in its ${WARNINGS_COLUMN} column.`;

function percent(rate: RuleRate): string {
  const pct = rate.total ? (100 * rate.violations) / rate.total : 0;
  return `${pct > 0 && pct < 0.1 ? '<0.1' : pct.toFixed(1)}%`;
}

const count = (n: number) => n.toLocaleString('en-US');

interface Item {
  text: string;      // the item without its rate
  rate?: string;     // 'none', '50.1%', '9.8% of 146,854', or absent
}

interface Group {
  title: string;
  items: Item[];
}

// The rows every row rule is measured over (they share one `checked` step).
function rowTotal(plan: EnforcementPlan, rates: Map<string, RuleRate>|undefined):
    number|undefined {
  for (const r of rowRules(plan)) {
    const rate = rates?.get(r.constraint);
    if (rate) return rate.total;
  }
  return undefined;
}

function groups(plan: EnforcementPlan, rates: Map<string, RuleRate>|undefined):
    Group[] {
  const rows = rowTotal(plan, rates);
  const item = (r: EnforcedRule, text: string): Item => {
    const rate = rates?.get(r.constraint);
    if (!rate) return {text};
    if (!rate.violations) return {text, rate: 'none'};
    return {
      text,
      rate: rate.total === rows ? percent(rate) :
                                  `${percent(rate)} of ${count(rate.total)}`,
    };
  };
  const of = (effect: EnforcementEffect) =>
      plan.rules.filter(r => r.effect === effect);
  const out: Group[] = [
    {title: 'Rows excluded', items: of('exclude').map(r => item(r, r.constraint))},
    {
      title: 'Values withheld (served as NULL)',
      items: of('withhold').map(r => item(r, `${r.field} by ${r.constraint}`)),
    },
    {title: 'Flagged only', items: of('flag').map(r => item(r, r.constraint))},
    {
      title: 'Spelling normalized to the allowed members',
      items: [...new Set(plan.repairs.map(r => r.field))].map(f => ({text: f})),
    },
    {title: 'Reported, not applied', items: of('report').map(r => item(r, r.constraint))},
  ];
  return out.filter(g => g.items.length);
}

function render(
    gs: Group[], rows: number|undefined, dropHolding: boolean,
    applies: boolean): string {
  let holding = 0;
  const parts = gs.map(g => {
    const shown = dropHolding ? g.items.filter(i => i.rate !== 'none') : g.items;
    holding += g.items.length - shown.length;
    if (!shown.length) return undefined;
    return `${g.title}: ${
        shown.map(i => i.rate ? `${i.text} (${i.rate})` : i.text).join(', ')}.`;
  });
  if (holding) {
    parts.push(`${holding} more rule${holding === 1 ? '' : 's'} hold${
        holding === 1 ? 's' : ''} on every row.`);
  }
  if (rows !== undefined) {
    parts.push(`Rates are over the ${count(rows)} hydrated rows.`);
  }
  const body = parts.filter(p => !!p).join(' ');
  // A view that applies no rule per row only reports: no lead, no _warnings.
  return applies ? [`${CONSTRAINTS_PREFIX}${LEAD}`, body].filter(p => !!p).join(' ') :
                   `${CONSTRAINTS_PREFIX}${body}`;
}

/**
 * The entity's constraints paragraph (one paragraph, see the file header), at
 * most `budget` characters: every rule with its rate when `rates` has one;
 * then, when that does not fit, the rules no row breaks folded into a count;
 * then the lead sentence alone. Undefined when the plan applies and reports
 * nothing, or nothing fits.
 */
export function constraintsTrailer(
    plan: EnforcementPlan|undefined, rates: Map<string, RuleRate>|undefined,
    budget: number): string|undefined {
  if (!plan || !plan.rules.length) return undefined;
  const gs = groups(plan, rates);
  const rows = rowTotal(plan, rates);
  const applies = rowRules(plan).length > 0;
  const options = [
    render(gs, rows, false, applies),
    render(gs, rows, true, applies),
    ...(applies ? [`${CONSTRAINTS_PREFIX}${LEAD}`] : []),
  ];
  return options.find(text => text.length <= budget);
}

/** The sentence an enforcing node view's description carries (no rates). */
export function constraintsSentence(plan: EnforcementPlan): string|undefined {
  if (!rowRules(plan).length) return undefined;
  return render(groups(plan, undefined), undefined, false, true);
}

const CONSTRAINTS = new RegExp(`^${CONSTRAINTS_PREFIX}(?:enforced in the node ` +
    `view after hydration; |Reported, not applied: ).*\\.$`);

/**
 * Peels the constraints paragraph (see constraintsTrailer) off a pulled
 * entity description; it is derived, so pull drops it. Text without one is
 * returned untouched.
 */
export function splitConstraintsTrailer(text: string|undefined):
    {rest: string|undefined} {
  if (text === undefined) return {rest: undefined};
  const paragraphs = text.split('\n\n');
  if (!CONSTRAINTS.test(paragraphs[paragraphs.length - 1])) return {rest: text};
  const rest = paragraphs.slice(0, -1).join('\n\n');
  return {rest: rest === '' ? undefined : rest};
}


// ---------------------------------------------------------------------------
// Measuring (network).
// ---------------------------------------------------------------------------

/** One entity's enforcement as the node-view lowering planned it. */
export interface PlannedEnforcement {
  plan: EnforcementPlan;
  ratesSql?: string;
}

/**
 * Measures how often each rule breaks, for the catalog paragraph: each
 * enforcing view's row rules over its `checked` rows (one query per view),
 * and the reported rules with the validation queries over the node views
 * (`lowered` is the model rewritten to read them). Errors are returned, not
 * thrown: a rate that could not be measured is simply left out.
 */
export async function measureConstraintRates(
    enforcement: ReadonlyMap<string, PlannedEnforcement>, lowered: SemanticModel,
    ctx: context.ApiContext,
    options: {project?: string; location?: string} = {}):
    Promise<{rates: ConstraintRates; errors: string[]}> {
  const client = new BigQueryClient(ctx);
  const project = options.project ?? ctx.project;
  const rates: ConstraintRates = new Map();
  const errors: string[] = [];
  const put = (entity: string, constraint: string, rate: RuleRate) => {
    if (!rates.has(entity)) rates.set(entity, new Map());
    rates.get(entity)!.set(constraint, rate);
  };

  await Promise.all([...enforcement.entries()].map(async ([entity, e]) => {
    if (!e.ratesSql) return;
    const res = await runQuery(client, project, e.ratesSql, options.location, false, 60);
    if (res.error || !res.rows?.length) {
      errors.push(`entity '${entity}': ${res.error ?? 'no result row'}`);
      return;
    }
    const row = res.rows[0];
    const total = Number(row[0] ?? 0);
    rowRules(e.plan).forEach((r, i) => {
      put(entity, r.constraint, {violations: Number(row[i + 1] ?? 0), total});
    });
  }));

  const reported = new Map<string, string>();  // constraint -> entity
  for (const [entity, e] of enforcement) {
    for (const r of e.plan.rules) {
      if (r.effect === 'report') reported.set(r.constraint, entity);
    }
  }
  if (reported.size) {
    const validation = planBigQueryValidation(
        {
          ...lowered,
          constraints: (lowered.constraints ?? []).filter(c => reported.has(c.name)),
        },
        {structural: false, examples: 0});
    const results = await runBigQueryValidation(
        validation, ctx, {project, location: options.location, examples: 0});
    for (const r of results) {
      const entity = reported.get(r.constraint);
      if (!entity) continue;
      if (r.violations === undefined || r.total === undefined) {
        errors.push(`constraint '${r.constraint}': ${r.error ?? 'not measured'}`);
        continue;
      }
      put(entity, r.constraint, {violations: r.violations, total: r.total});
    }
  }
  return {rates, errors};
}
