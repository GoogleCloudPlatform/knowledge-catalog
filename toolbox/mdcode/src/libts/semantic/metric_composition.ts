// Composite metrics (K6b, a proposed kcmd enhancement): a metric whose
// expression is a formula over several aggregates is split into
// single-aggregate COMPONENTS -- each one a BigQuery graph MEASURE -- plus a
// COMPOSITION that recombines them at query time.
//
// A BigQuery graph MEASURE is exactly one aggregate (SUM, AVG, COUNT, MIN or
// MAX) over one node table's property. A ratio such as
//
//   100 * SAFE_DIVIDE(SUM(T.a) - SUM(T.b), SUM(T.a))
//
// is therefore not a measure, but its pieces are, and `AGG()` of each piece
// can be recombined over GRAPH_EXPAND:
//
//   100 * SAFE_DIVIDE(AGG(T_a_measure) - AGG(T_b_measure), AGG(T_a_measure))
//
// (verified live: ratios of AGG() work over GRAPH_EXPAND). This module does
// the split, and nothing else: which graph a component lands on is the slice
// planner's job (metric_slices.ts).
//
// Conditional counts. COUNTIF is not a measure aggregate (BigQuery rejects
// it inside MEASURE), so `COUNTIF(cond)` becomes a SUM:
//   - `SUM(CAST(T.is<Defined> AS INT64))` when `cond` is exactly the
//     membership predicate of a defined entity (K1, defined_entities.ts) on
//     T, whose boolean membership property the graph legs already add;
//   - `SUM(CASE WHEN cond THEN 1 ELSE 0 END)` otherwise.
//
// Divisions. A `/` in the composition becomes SAFE_DIVIDE, so a group with a
// zero denominator reads NULL instead of failing the whole query; a numeric
// multiplier on the dividend is kept outside (`100 * SAFE_DIVIDE(n, d)`).

import {DefinedEntityInfo, membershipPropertyName} from './defined_entities';
import {Entity, Metric} from './ir';
import {blankStringLiterals, mapOutsideStringLiterals, referencedEntityNames, stripQualifier} from './sql_expr_utils';

/**
 * Aggregate functions BigQuery accepts inside MEASURE(...) -- the complete
 * allowed set (see bigquery.ts, where the same list gates measure lowering).
 */
export const MEASURE_AGGREGATES: readonly string[] =
    ['SUM', 'AVG', 'COUNT', 'MIN', 'MAX'];

// Aggregate functions that exist in GoogleSQL but cannot be a MEASURE and
// have no rewrite here (COUNTIF has one, see above). Recognizing them keeps a
// formula that uses one from being mistaken for a composition of measures.
const OTHER_AGGREGATES = new Set<string>([
  'ANY_VALUE', 'ARRAY_AGG', 'ARRAY_CONCAT_AGG', 'BIT_AND', 'BIT_OR', 'BIT_XOR',
  'LOGICAL_AND', 'LOGICAL_OR', 'MAX_BY', 'MIN_BY', 'STRING_AGG', 'GROUPING',
  'APPROX_COUNT_DISTINCT', 'APPROX_QUANTILES', 'APPROX_TOP_COUNT',
  'APPROX_TOP_SUM', 'CORR', 'COVAR_POP', 'COVAR_SAMP', 'STDDEV', 'STDDEV_POP',
  'STDDEV_SAMP', 'VAR_POP', 'VAR_SAMP', 'VARIANCE', 'PERCENTILE_CONT',
  'PERCENTILE_DISC', 'AVG_IF', 'SUM_IF', 'COUNT_IF',
]);

// Aggregates that give the same result when a row is repeated: safe to
// evaluate over a flattened view where a coarser entity's row repeats once
// per finer row (see metric_slices.ts fallback views).
export const DUPLICATE_INSENSITIVE = new Set<string>(
    ['MIN', 'MAX', 'ANY_VALUE', 'LOGICAL_AND', 'LOGICAL_OR', 'BIT_AND', 'BIT_OR',
     'APPROX_COUNT_DISTINCT']);

/** One aggregate call found in an expression. */
export interface AggregateCall {
  /** The function name, uppercased. */
  fn: string;
  distinct: boolean;
  /** The argument text as written (after DISTINCT). */
  operand: string;
  /** Span of the whole call in the expression, end exclusive. */
  start: number;
  end: number;
}

/** A single-aggregate piece of a metric, ready to be a MEASURE. */
export interface MetricComponent {
  /**
   * The measure name: the metric's own name for a simple metric, the name of
   * an existing simple metric computing the same aggregate (reused), or
   * `<metric>__agg<N>` (N = 1-based position in the formula).
   */
  name: string;
  /** The aggregate as a measure expression, entity-qualified. */
  expression: string;
  /** The aggregate function (one of MEASURE_AGGREGATES). */
  fn: string;
  distinct: boolean;
  operand: string;
  /** The one entity the aggregate reads. */
  entity: string;
  /** True when `name` is another (simple) metric of the model. */
  reused: boolean;
  /** Set when a COUNTIF was rewritten: how, and the flag used if any. */
  countIf?: {via: 'membership'|'case'; flag?: string; condition: string};
}

/** A metric split into components and their composition. */
export interface MetricDecomposition {
  metric: string;
  /** Distinct components, in order of first appearance in the formula. */
  components: MetricComponent[];
  /**
   * The formula with component i written `{{i}}` (and `/` as SAFE_DIVIDE).
   * `{{0}}` alone for a simple metric.
   */
  template: string;
  /** Exactly one aggregate and nothing around it. */
  simple: boolean;
  /** The entities the components read, in order of first appearance. */
  entities: string[];
}

export type Decomposed = {ok: true; value: MetricDecomposition}|
                         {ok: false; reason: string};

/** What decomposition needs to know about the model. */
export interface CompositionContext {
  /** Entity names that may qualify a field (non-defined entities). */
  entityNames: string[];
  /** Resolved (flattened) entities, for membership-property lookups. */
  entities: Map<string, Entity>;
  /** K1 defined entities of the source model (before lowering). */
  defined: Map<string, DefinedEntityInfo>;
  /**
   * Normalized single aggregate (see aggregateKey) -> the simple metric that
   * computes it, so a composite reuses that measure instead of a duplicate.
   */
  simpleMetrics?: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Scanning.
// ---------------------------------------------------------------------------

/**
 * Finds every aggregate call in `expression`. Fails (with a reason) on an
 * aggregate this module cannot split: a window function (`... OVER`), an
 * aggregate nested in another, a multi-argument aggregate, or one with
 * ORDER BY / LIMIT / IGNORE NULLS / HAVING inside its parentheses.
 */
export function findAggregateCalls(expression: string):
    {calls: AggregateCall[]}|{error: string} {
  const scan = blankQuoted(expression);
  const calls: AggregateCall[] = [];
  const re = /[A-Za-z_][A-Za-z0-9_]*/g;
  let m: RegExpExecArray|null;
  while ((m = re.exec(scan)) !== null) {
    const name = m[0].toUpperCase();
    const isAggregate = MEASURE_AGGREGATES.includes(name) ||
        name === 'COUNTIF' || OTHER_AGGREGATES.has(name);
    if (!isAggregate) continue;
    let open = m.index + m[0].length;
    while (open < scan.length && /\s/.test(scan[open])) open++;
    if (scan[open] !== '(') continue;  // a column named like an aggregate
    if (scan.slice(0, m.index).trimEnd().endsWith('.')) {
      return {error: `'${m[0]}' is called with a qualifier`};
    }
    const close = matchingParen(scan, open);
    if (close < 0) return {error: 'unbalanced parentheses'};
    if (/^\s*OVER\b/i.test(scan.slice(close + 1))) {
      return {error: `${name}(...) OVER is a window function, not an aggregate`};
    }
    const inner = expression.slice(open + 1, close);
    const innerScan = scan.slice(open + 1, close);
    if (hasAggregateCall(innerScan)) {
      return {error: `${name}(...) nests another aggregate`};
    }
    if (topLevelComma(innerScan)) {
      return {error: `${name}(...) takes several arguments`};
    }
    if (/\b(ORDER\s+BY|LIMIT|IGNORE\s+NULLS|RESPECT\s+NULLS|HAVING)\b/i.test(
            innerScan)) {
      return {error: `${name}(...) has a clause inside its parentheses`};
    }
    const dm = /^\s*DISTINCT\s+/i.exec(inner);
    calls.push({
      fn: name,
      distinct: !!dm,
      operand: (dm ? inner.slice(dm[0].length) : inner).trim(),
      start: m.index,
      end: close + 1,
    });
    re.lastIndex = close + 1;
  }
  return {calls};
}

// String literals and backtick-quoted identifiers blanked (same length), so
// offsets line up with the original text.
function blankQuoted(expression: string): string {
  return blankStringLiterals(expression).replace(/`[^`]*`/g, s => ' '.repeat(s.length));
}

function matchingParen(scan: string, open: number): number {
  let depth = 0;
  for (let i = open; i < scan.length; i++) {
    if (scan[i] === '(') depth++;
    else if (scan[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

function topLevelComma(scan: string): boolean {
  let depth = 0;
  for (const c of scan) {
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) return true;
  }
  return false;
}

function hasAggregateCall(scan: string): boolean {
  for (const m of scan.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    const name = m[1].toUpperCase();
    if (MEASURE_AGGREGATES.includes(name) || name === 'COUNTIF' ||
        OTHER_AGGREGATES.has(name)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Decomposition.
// ---------------------------------------------------------------------------

/**
 * A normalized identity for one single aggregate, so equal aggregates written
 * differently (spacing, keyword case) dedupe and reuse each other.
 */
export function aggregateKey(
    entity: string, fn: string, distinct: boolean, operand: string): string {
  return `${entity}|${fn.toUpperCase()}|${distinct ? 'D' : ''}|${
      normalizeSql(operand)}`;
}

/**
 * Splits a metric into components and a composition. `ctx.simpleMetrics`
 * lets a composite reuse another metric's measure; leave it unset to index
 * the simple metrics themselves (see simpleMetricIndex).
 */
export function decomposeMetric(
    metric: Metric, ctx: CompositionContext): Decomposed {
  const expression = metric.expression ?? metric.importedExpression;
  if (expression === undefined || !expression.trim()) {
    return {ok: false, reason: 'it has no expression'};
  }
  const found = findAggregateCalls(expression);
  if ('error' in found) return {ok: false, reason: found.error};
  if (!found.calls.length) {
    return {ok: false, reason: 'it contains no aggregate'};
  }

  // The formula around the aggregates may combine them, but must not read a
  // field itself: outside an aggregate there is no row to read it from.
  const around = spliceCalls(expression, found.calls, () => ' 0 ');
  const loose = referencedEntityNames(around, ctx.entityNames);
  if (loose.length) {
    return {
      ok: false,
      reason: `it reads ${loose.join(', ')} fields outside any aggregate`,
    };
  }

  type Draft = Omit<MetricComponent, 'name'|'reused'|'entity'>&{
    entity?: string; key?: string;
  };
  const drafts: Draft[] = [];
  const indexOf = new Map<string, number>();  // dedupe key -> draft index
  const callIndex: number[] = [];
  for (const call of found.calls) {
    if (OTHER_AGGREGATES.has(call.fn)) {
      return {
        ok: false,
        reason: `${call.fn} cannot be a MEASURE (a measure is one of ${
            MEASURE_AGGREGATES.join(', ')})`,
      };
    }
    const draft = call.fn === 'COUNTIF' ? lowerCountIf(call, ctx) :
                                          plainDraft(call, ctx);
    if ('error' in draft) return {ok: false, reason: draft.error};
    const dedupe = `${draft.entity ?? ''}|${draft.fn}|${draft.distinct}|${
        normalizeSql(draft.operand)}`;
    let at = indexOf.get(dedupe);
    if (at === undefined) {
      at = drafts.length;
      drafts.push(draft);
      indexOf.set(dedupe, at);
    }
    callIndex.push(at);
  }

  // An aggregate that names no entity (COUNT(*), COUNT(1)) counts the rows of
  // the entity its siblings read, else the metric's declared entity.
  const named = [...new Set(drafts.map(d => d.entity).filter((e): e is string => !!e))];
  const fallbackEntity = named.length === 1 ? named[0] : metric.entity;
  for (const d of drafts) {
    if (d.entity) continue;
    if (!fallbackEntity) {
      return {
        ok: false,
        reason: `${d.fn}(${d.operand}) names no entity, and the metric ` +
            `does not say which entity's rows it counts`,
      };
    }
    d.entity = fallbackEntity;
  }

  let template = spliceCalls(expression, found.calls, i => `{{${callIndex[i]}}}`).trim();
  const simple = drafts.length === 1 && stripOuterParens(template) === '{{0}}';
  if (simple) template = '{{0}}';
  else template = safeDivisions(template);

  const components: MetricComponent[] = drafts.map((d, i) => {
    const key = aggregateKey(d.entity!, d.fn, d.distinct, d.operand);
    const reusedName = simple ? undefined : ctx.simpleMetrics?.get(key);
    const name = simple ? metric.name : reusedName ?? `${metric.name}__agg${i + 1}`;
    const component: MetricComponent = {
      name,
      expression: d.expression,
      fn: d.fn,
      distinct: d.distinct,
      operand: d.operand,
      entity: d.entity!,
      reused: !!reusedName && reusedName !== metric.name,
    };
    if (d.countIf) component.countIf = d.countIf;
    return component;
  });
  const entities = [...new Set(components.map(c => c.entity))];
  return {
    ok: true,
    value: {metric: metric.name, components, template, simple, entities},
  };
}

/**
 * Normalized single aggregate -> name, for every metric that is exactly one
 * aggregate. The first metric by name wins when two compute the same thing.
 */
export function simpleMetricIndex(
    metrics: readonly Metric[], ctx: CompositionContext): Map<string, string> {
  const out = new Map<string, string>();
  const bare: CompositionContext = {...ctx, simpleMetrics: undefined};
  for (const m of [...metrics].sort((a, b) => a.name < b.name ? -1 : 1)) {
    const d = decomposeMetric(m, bare);
    if (!d.ok || !d.value.simple) continue;
    const c = d.value.components[0];
    const key = aggregateKey(c.entity, c.fn, c.distinct, c.operand);
    if (!out.has(key)) out.set(key, m.name);
  }
  return out;
}

type DraftResult = {
  expression: string; fn: string; distinct: boolean; operand: string;
  entity?: string;
  countIf?: MetricComponent['countIf'];
}|{error: string};

function plainDraft(call: AggregateCall, ctx: CompositionContext): DraftResult {
  const entities = referencedEntityNames(call.operand, ctx.entityNames);
  if (entities.length > 1) {
    return {
      error: `${call.fn}(${collapse(call.operand)}) reads several entities (${
          entities.join(', ')}); a MEASURE reads one table`,
    };
  }
  return {
    expression: `${call.fn}(${call.distinct ? 'DISTINCT ' : ''}${call.operand})`,
    fn: call.fn,
    distinct: call.distinct,
    operand: call.operand,
    entity: entities[0],
  };
}

// COUNTIF(cond) -> SUM over the defined entity's membership flag when `cond`
// is that entity's predicate, else SUM over a CASE.
function lowerCountIf(call: AggregateCall, ctx: CompositionContext): DraftResult {
  if (call.distinct) return {error: 'COUNTIF(DISTINCT ...) is not valid SQL'};
  const condition = call.operand;
  const entities = referencedEntityNames(condition, ctx.entityNames);
  if (entities.length > 1) {
    return {
      error: `COUNTIF(${collapse(condition)}) reads several entities (${
          entities.join(', ')}); a MEASURE reads one table`,
    };
  }
  const entity = entities[0];
  const flag = entity ? membershipFlag(condition, entity, ctx) : undefined;
  if (entity && flag) {
    const operand = `CAST(${entity}.${flag} AS INT64)`;
    return {
      expression: `SUM(${operand})`,
      fn: 'SUM',
      distinct: false,
      operand,
      entity,
      countIf: {via: 'membership', flag, condition},
    };
  }
  const operand = `CASE WHEN ${condition} THEN 1 ELSE 0 END`;
  return {
    expression: `SUM(${operand})`,
    fn: 'SUM',
    distinct: false,
    operand,
    entity,
    countIf: {via: 'case', condition},
  };
}

// The membership property (`is<Defined>`) whose predicate `condition` states,
// when `entity` (or an ancestor of it) is that defined entity's base and the
// lowered model carries the property on `entity`.
function membershipFlag(
    condition: string, entity: string,
    ctx: CompositionContext): string|undefined {
  const resolved = ctx.entities.get(entity);
  if (!resolved) return undefined;
  const lineage = new Set([entity, ...(resolved.extends ?? [])]);
  let local = condition;
  for (const name of lineage) local = stripQualifier(local, name);
  const wanted = conjuncts(local);
  const matches = [...ctx.defined.values()]
                      .filter(info => lineage.has(info.base))
                      .filter(info => sameConjuncts(conjuncts(info.membership), wanted))
                      .map(info => membershipPropertyName(info.name))
                      .filter(flag => resolved.fields.some(f => f.name === flag))
                      .sort();
  return matches[0];
}

function sameConjuncts(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

// The top-level AND-ed parts of a predicate, each normalized, sorted: so
// `(a) AND (b)` (a defined entity's chained membership) equals `b AND a`.
function conjuncts(predicate: string): string[] {
  const text = stripOuterParens(predicate.trim());
  const scan = blankQuoted(text);
  const parts: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < scan.length; i++) {
    const c = scan[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && /\s/.test(c) &&
             /^\s+AND\s+/i.test(scan.slice(i)) &&
             !/\bBETWEEN\s+\S+\s*$/i.test(scan.slice(last, i))) {
      parts.push(text.slice(last, i));
      const skip = /^\s+AND\s+/i.exec(scan.slice(i))![0].length;
      i += skip - 1;
      last = i + 1;
    }
  }
  parts.push(text.slice(last));
  return parts.map(p => normalizeSql(stripOuterParens(p.trim()))).sort();
}

// Whitespace collapsed and dropped around punctuation, keywords and names
// uppercased -- all outside string literals, whose contents are data.
export function normalizeSql(sql: string): string {
  return mapOutsideStringLiterals(
             sql.trim(),
             seg => seg.replace(/\s+/g, ' ')
                        .replace(/\s*([(),=<>!+*/%-])\s*/g, '$1')
                        .toUpperCase())
      .trim();
}

function stripOuterParens(text: string): string {
  let s = text.trim();
  while (s.startsWith('(')) {
    const close = matchingParen(blankQuoted(s), 0);
    if (close !== s.length - 1) break;
    s = s.slice(1, -1).trim();
  }
  return s;
}

function spliceCalls(
    expression: string, calls: AggregateCall[],
    replacement: (i: number) => string): string {
  let out = '';
  let last = 0;
  calls.forEach((call, i) => {
    out += expression.slice(last, call.start) + replacement(i);
    last = call.end;
  });
  return out + expression.slice(last);
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// The composition: rendering and `/` -> SAFE_DIVIDE.
// ---------------------------------------------------------------------------

/**
 * Renders a composition, replacing component i with `ref(i)`: e.g.
 * `AGG(<NodeTable>_<measure>)` over GRAPH_EXPAND.
 */
export function renderComposition(
    template: string, ref: (i: number) => string): string {
  return template.replace(/\{\{(\d+)\}\}/g, (_, i: string) => ref(Number(i)));
}

type Node = {k: 'leaf'; text: string}|{k: 'call'; name: string; args: Node[]}|
            {k: 'bin'; op: string; l: Node; r: Node}|{k: 'neg'; e: Node};

/**
 * Rewrites each `/` of an arithmetic composition into SAFE_DIVIDE, keeping a
 * numeric multiplier of the dividend outside: `100 * {{0}} / ({{0}} + {{1}})`
 * becomes `100 * SAFE_DIVIDE({{0}}, {{0}} + {{1}})`. A template that is not
 * plain arithmetic over placeholders, numbers and function calls (a CASE, a
 * comparison, a string) is returned unchanged.
 */
export function safeDivisions(template: string): string {
  if (!template.includes('/')) return template;
  const tokens = tokenize(template);
  if (!tokens) return template;
  let at = 0;
  const peek = () => tokens[at];
  const take = () => tokens[at++];
  const expr = (): Node|undefined => {
    let left = term();
    while (left && (peek() === '+' || peek() === '-')) {
      const op = take();
      const right = term();
      if (!right) return undefined;
      left = {k: 'bin', op, l: left, r: right};
    }
    return left;
  };
  const term = (): Node|undefined => {
    let left = unary();
    while (left && (peek() === '*' || peek() === '/')) {
      const op = take();
      const right = unary();
      if (!right) return undefined;
      left = {k: 'bin', op, l: left, r: right};
    }
    return left;
  };
  const unary = (): Node|undefined => {
    if (peek() === '-') {
      take();
      const e = unary();
      return e ? {k: 'neg', e} : undefined;
    }
    return primary();
  };
  const primary = (): Node|undefined => {
    const t = take();
    if (t === undefined) return undefined;
    if (t === '(') {
      const e = expr();
      return e && take() === ')' ? e : undefined;
    }
    if (/^[A-Za-z_]/.test(t) && peek() === '(') {
      take();
      const args: Node[] = [];
      if (peek() !== ')') {
        for (;;) {
          const a = expr();
          if (!a) return undefined;
          args.push(a);
          if (peek() !== ',') break;
          take();
        }
      }
      return take() === ')' ? {k: 'call', name: t, args} : undefined;
    }
    if (/^(\{\{\d+\}\}|\d)/.test(t) || /^(NULL|TRUE|FALSE)$/i.test(t)) {
      return {k: 'leaf', text: t};
    }
    return undefined;
  };
  const tree = expr();
  if (!tree || at !== tokens.length) return template;
  return print(divide(tree));
}

function tokenize(text: string): string[]|undefined {
  const out: string[] = [];
  const re = /\s*(\{\{\d+\}\}|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[A-Za-z_][A-Za-z0-9_]*|[-+*/(),])/y;
  let at = 0;
  while (at < text.length) {
    if (/^\s+$/.test(text.slice(at))) break;
    re.lastIndex = at;
    const m = re.exec(text);
    if (!m) return undefined;
    out.push(m[1]);
    at = re.lastIndex;
  }
  return out;
}

function isNumber(n: Node): boolean {
  return n.k === 'leaf' && /^\d/.test(n.text);
}

function divide(n: Node): Node {
  if (n.k === 'leaf') return n;
  if (n.k === 'neg') return {k: 'neg', e: divide(n.e)};
  if (n.k === 'call') return {...n, args: n.args.map(divide)};
  const l = divide(n.l);
  const r = divide(n.r);
  if (n.op !== '/') return {...n, l, r};
  // (k * x) / y -> k * SAFE_DIVIDE(x, y); (x * k) / y -> SAFE_DIVIDE(x, y) * k.
  if (l.k === 'bin' && l.op === '*' && isNumber(l.l)) {
    return {k: 'bin', op: '*', l: l.l, r: safeDivide(l.r, r)};
  }
  if (l.k === 'bin' && l.op === '*' && isNumber(l.r)) {
    return {k: 'bin', op: '*', l: safeDivide(l.l, r), r: l.r};
  }
  return safeDivide(l, r);
}

function safeDivide(l: Node, r: Node): Node {
  return {k: 'call', name: 'SAFE_DIVIDE', args: [l, r]};
}

function precedence(n: Node): number {
  if (n.k === 'bin') return n.op === '+' || n.op === '-' ? 1 : 2;
  if (n.k === 'neg') return 3;
  return 4;
}

function print(n: Node): string {
  switch (n.k) {
    case 'leaf':
      return n.text;
    case 'call':
      return `${n.name}(${n.args.map(print).join(', ')})`;
    case 'neg':
      return `-${precedence(n.e) < 3 ? `(${print(n.e)})` : print(n.e)}`;
    case 'bin': {
      const p = precedence(n);
      const l = precedence(n.l) < p ? `(${print(n.l)})` : print(n.l);
      const r = precedence(n.r) <= p && n.r.k === 'bin' ? `(${print(n.r)})` :
                                                          print(n.r);
      return `${l} ${n.op} ${r}`;
    }
  }
}
