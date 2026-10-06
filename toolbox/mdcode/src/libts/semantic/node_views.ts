// Node views: the BigQuery leg's hydration layer (see hydration.ts).
//
// A property graph is a schema over tables, and BigQuery does not enforce a
// node table's KEY: a key the source repeats silently doubles matches and
// measures. So, by default, every bound concrete entity is read through a
// view kcmd generates next to the graph, named after the entity
// (`snake_case(entity)`), whose columns are the entity's modeled fields
// (`snake_case(field)`) and whose rows realize the model's key:
//
//   CREATE OR REPLACE VIEW `p.semantic.opportunity`
//   OPTIONS (description = '... Key: opportunity_id. Hydration: latest version
//            per opportunity_id by created_at; wonAmount ÷100 before
//            2024-03-25. Source: ps_crm.opportunity. ...') AS
//   SELECT
//     t.opportunity_id,
//     IF(CAST(t.created_at AS DATE) < DATE '2024-03-25', t.won_amount / 100,
//        t.won_amount) AS won_amount,
//     COALESCE(r0._kcmd_code, t.market_unit) AS market_unit
//   FROM `p.ps_crm.opportunity` AS t
//   LEFT JOIN (<one row per normalized match value>) AS r0
//     ON r0._kcmd_match = LOWER(TRIM(t.market_unit))
//   QUALIFY ROW_NUMBER() OVER (PARTITION BY t.opportunity_id
//     ORDER BY t.created_at DESC, FARM_FINGERPRINT(TO_JSON_STRING(t))) = 1
//
// The lowering rewrites the model so the rest of the leg needs no change: the
// entity's source becomes its view and each field reads its view column, so
// node tables, edges (a foreign key is read from the source entity's view),
// vocabulary edges, derived relationships, measures and metric graphs all read
// the hydrated rows. An entity with no rule gets a pass-through view (still
// named after the entity, still only the modeled columns).
//
// Rule shapes:
//   - grain        QUALIFY ROW_NUMBER() ... = 1, keeping the greatest latest_by
//                  per key (ties, and `deterministic`, by a hash of the row).
//   - normalize    IF(<on> < DATE '<d>', <col> / n, <col>); `after` is >=.
//   - resolve      the foreign key rewritten to the destination's key when the
//                  recorded value matches (case-insensitively, trimmed) the
//                  destination's key or a listed unique key: COALESCE(<key>,
//                  <as recorded>). The key match wins over a unique-key match;
//                  a value matching several destinations stays as recorded,
//                  as does one matching none, so a relationship check still
//                  reports it. The lookup is grouped to one row per value, so
//                  it never changes the view's grain.
//   - derive_from  SELECT DISTINCT <fk> AS <key> over the relationship's
//                  source entity (its view, so resolved values are used).
//
// `mode: direct` opts an entity out: it binds the source table as-is, as
// before node views existed. A `resolve` rule on a direct entity is applied in
// a generated `edge_<relationship>` view instead (the foreign key matched to
// the destination's key or unique key), since there is no node view to carry
// the canonical value.

import {aliased, edgeViewName, GeneratedView, oneLine, snakeCase, sqlInteger, sqlString, tableName, viewRef, ViewTarget} from './generated_views';
import {hasNoSource, hydrationClauses, isDerivedEntity, isDirect, isMatchableField, isTimestampBound, resolveRelationship} from './hydration';
import {Entity, Field, fieldBinding, NormalizeRule, Relationship, SemanticModel, VocabularyMember} from './ir';
import {resolveInheritance} from './resolve_inheritance';
import {stripQualifier} from './sql_expr_utils';
import {quoteIfReserved} from './sql_identifiers';
import {generatesVocabularyView, isVocabulary, vocabularyViewName, withVocabularyBindings} from './vocabulary';

export interface NodeViewLowering {
  // The model rewritten to read every node view (the input is not mutated).
  model: SemanticModel;
  // Node views in dependency order, then the resolved-edge views of direct
  // entities. All must exist before the graph (see orderGeneratedViews).
  views: GeneratedView[];
  // One human line per generated view, for `push --dry-run` / `--print`.
  plan: string[];
}

/**
 * Binds the key field of a derived entity (hydration.derive_from) to its node
 * view's key column, where the model leaves it unbound: the entity has no
 * table, and its key is exactly what its view produces. Every other field of
 * a derived entity stays unbound. Returns the input untouched for any other
 * entity; never mutates it. The availability pass runs this (as it does
 * vocabulary bindings) so the entity is not dropped for an unbound key.
 */
export function withHydrationBindings(entity: Entity): Entity {
  if (!isDerivedEntity(entity) || entity.keys.length !== 1) return entity;
  const key = entity.keys[0];
  const fields = entity.fields.map(
      f => f.name === key && fieldBinding(f) === undefined ?
          {...f, expression: snakeCase(key)} :
          f);
  if (!fields.some(f => f.name === key)) {
    fields.unshift({name: key, expression: snakeCase(key)});
  }
  return {...entity, fields};
}

// Whether an entity is read through a node view under this lowering.
function wantsNodeView(e: Entity): boolean {
  if (e.abstract || e.definition || isVocabulary(e) || isDirect(e)) return false;
  if (!(e.keys ?? []).length) return false;
  return isDerivedEntity(e) || !hasNoSource(e);
}

function bareRef(dataSource: string): string {
  return dataSource.replace(/`/g, '').trim();
}

// `FROM` target for a source: a backticked table reference, or a verbatim
// query (whitespace) as a parenthesized subquery.
function fromTarget(dataSource: string): string {
  const s = dataSource.trim();
  return /\s/.test(s) ? `(${s})` : `\`${bareRef(s)}\``;
}

// `dataset.table` (the last two segments) for a description.
function shortSource(dataSource: string): string {
  const s = dataSource.trim();
  if (/\s/.test(s)) return 'a query';
  const parts = bareRef(s).split('.');
  return parts.slice(-2).join('.');
}

function textual(field: Field|undefined): boolean {
  return field?.type === undefined || field.type === 'String';
}

// LOWER(TRIM(x)), casting a non-text value to STRING first.
function normalized(expr: string, isText: boolean): string {
  return isText ? `LOWER(TRIM(${expr}))` :
                  `LOWER(TRIM(CAST(${expr} AS STRING)))`;
}

function sentence(text: string): string {
  const t = oneLine(text);
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/** One column of a lookup table read by a resolve rule. */
interface LookupColumn {
  expr: string;     // through alias `d`
  isText: boolean;
}

/** Where a resolve rule's lookup reads the destination from. */
interface LookupSource {
  from: string;                     // FROM target (aliased `d` by the caller)
  code: LookupColumn;               // the destination's key
  matches: LookupColumn[];          // in priority order (key first)
}

/**
 * The lookup subquery for a resolve rule: one row per normalized match value
 * with the destination key it resolves to (NULL when it is ambiguous). The key
 * match outranks a unique-key match.
 */
function lookupSql(src: LookupSource, indent: string): string {
  const branches = src.matches.map(
      (m, i) => `${indent}      SELECT ${normalized(m.expr, m.isText)} AS ` +
          `_kcmd_match, ${src.code.expr} AS _kcmd_code, ${i} AS _kcmd_rank ` +
          `FROM ${src.from} AS d`);
  return [
    `(`,
    `${indent}  SELECT _kcmd_match, IF(COUNT(DISTINCT _kcmd_code) = 1, ` +
        `ANY_VALUE(_kcmd_code), NULL) AS _kcmd_code`,
    `${indent}  FROM (`,
    `${indent}    SELECT *, MIN(_kcmd_rank) OVER (PARTITION BY _kcmd_match) ` +
        `AS _kcmd_best`,
    `${indent}    FROM (`,
    branches.join(`\n${indent}      UNION ALL\n`),
    `${indent}    )`,
    `${indent}    WHERE _kcmd_match IS NOT NULL AND _kcmd_code IS NOT NULL`,
    `${indent}  )`,
    `${indent}  WHERE _kcmd_rank = _kcmd_best`,
    `${indent}  GROUP BY _kcmd_match`,
    `${indent})`,
  ].join('\n');
}

// A vocabulary's members as an inline table with the requested view columns
// (code, label, definition, iri), so a lookup needs no view of its own.
function membersTable(members: VocabularyMember[], columns: string[]): string|
    undefined {
  const value = (m: VocabularyMember, c: string): string|undefined => {
    switch (c) {
      case 'code':
        return sqlString(m.code);
      case 'label':
        return sqlString(m.label ?? m.code);
      case 'definition':
        return sqlString(m.definition);
      case 'iri':
        return sqlString(m.iri);
      case 'sort_order':
        return sqlInteger(m.order);
      default:
        return undefined;
    }
  };
  if (columns.some(c => value({code: ''}, c) === undefined)) return undefined;
  if (!members.length) {
    const types = columns.map(c => `${c} ${c === 'sort_order' ? 'INT64' : 'STRING'}`);
    return `UNNEST(ARRAY<STRUCT<${types.join(', ')}>>[])`;
  }
  const rows = members.map(
      m => `STRUCT(${columns.map(c => `${value(m, c)} AS ${c}`).join(', ')})`);
  return `UNNEST([${rows.join(', ')}])`;
}

interface Planned {
  entity: Entity;       // as declared (unresolved)
  resolved: Entity;     // inheritance flattened
  name: string;         // view name
  ref: string;          // qualified view reference
  columns: Map<string, string>;  // bound field name -> view column
}

/**
 * Lowers a model's entities onto node views for a BigQuery graph (see the
 * file header). Returns the rewritten model, the views to deploy and a plan
 * line per view. Run before every other BigQuery lowering (defined entities,
 * inheritance, vocabularies, derived relationships), which then read the
 * views. A model in which no entity qualifies is returned as-is.
 */
export function lowerNodeViews(
    model: SemanticModel, target: ViewTarget,
    warnings: string[]): NodeViewLowering {
  const entities = (model.entities ?? []).map(withHydrationBindings);
  const relationships = model.relationships ?? [];
  const working: SemanticModel = {...model, entities};
  let resolvedEntities: Entity[];
  try {
    resolvedEntities = resolveInheritance(working).model.entities ?? [];
  } catch {
    // A dangling `extends`: the graph leg reports it; bind directly.
    return {model, views: [], plan: []};
  }
  const resolvedByName = new Map(resolvedEntities.map(e => [e.name, e]));
  const declaredByName = new Map(entities.map(e => [e.name, e]));

  // Names other generated views use, so a node view never replaces one.
  const taken = new Set<string>([
    ...entities.filter(isVocabulary).map(e => vocabularyViewName(e.name)),
    ...relationships.map(r => edgeViewName(r.name)),
  ]);

  // Tables the model reads, so a node view never replaces one.
  const sourceRefs = new Map<string, string>();
  for (const e of entities) {
    if (!hasNoSource(e) && !/\s/.test(e.dataSource.trim())) {
      sourceRefs.set(bareRef(e.dataSource), e.name);
    }
  }

  const planned = new Map<string, Planned>();
  for (const e of entities) {
    if (!wantsNodeView(e)) continue;
    const resolved = resolvedByName.get(e.name);
    if (!resolved) continue;
    const name = snakeCase(e.name);
    const ref = viewRef(name, target);
    const at = `entity '${e.name}'`;
    const owner = sourceRefs.get(ref);
    if (owner !== undefined) {
      warnings.push(`${at}: its node view '${ref}' would replace ${
          owner === e.name ? 'its own source table' :
                             `the source table of entity '${owner}'`}; the ` +
          `table is bound directly (deploy the graph to another dataset, or ` +
          `set 'mode: direct' to silence this)`);
      continue;
    }
    if (taken.has(name)) {
      warnings.push(`${at}: its node view name '${name}' is already used by ` +
          `another generated view; the source is bound directly`);
      continue;
    }
    const columns = new Map<string, string>();
    const owners = new Map<string, string>();
    let clash: string|undefined;
    const bound = isDerivedEntity(e) ?
        resolved.fields.filter(f => f.name === e.keys[0]) :
        resolved.fields.filter(f => fieldBinding(f) !== undefined);
    for (const f of bound) {
      const col = snakeCase(f.name);
      if (owners.has(col)) {
        clash = `fields '${owners.get(col)}' and '${f.name}' both map to ` +
            `column '${col}'`;
        break;
      }
      owners.set(col, f.name);
      columns.set(f.name, col);
    }
    if (clash) {
      warnings.push(`${at}: ${clash} in its node view; the source is bound ` +
          `directly (rename one field)`);
      continue;
    }
    taken.add(name);
    planned.set(e.name, {entity: e, resolved, name, ref, columns});
  }

  const views = new Map<string, GeneratedView>();
  const deps = new Map<string, string[]>();
  const plan = new Map<string, string>();
  const dropped = new Set<string>();

  for (const p of planned.values()) {
    const built = isDerivedEntity(p.entity) ?
        derivedViewSql(p, working, planned, resolvedByName, warnings) :
        tableViewSql(p, working, declaredByName, resolvedByName, warnings);
    if (!built) {
      dropped.add(p.entity.name);
      continue;
    }
    views.set(p.entity.name, {
      name: p.name,
      ref: p.ref,
      kind: 'node',
      ddl: built.ddl,
      element: p.entity.name,
    });
    deps.set(p.entity.name, built.deps);
    const clauses = hydrationClauses(p.entity, destinationNamer(working, p.entity));
    plan.set(p.entity.name, `node view ${p.ref} (${p.entity.name}): ${
        clauses.length ? clauses.join('; ') : 'pass-through'}`);
  }
  for (const name of dropped) planned.delete(name);

  // Dependency order: a view is created after the views it reads (a derived
  // entity reads its relationship's source entity view). Stable otherwise.
  const ordered: string[] = [];
  const state = new Map<string, 'visiting'|'done'>();
  const visit = (name: string): boolean => {
    if (state.get(name) === 'done') return true;
    if (state.get(name) === 'visiting') return false;
    state.set(name, 'visiting');
    for (const d of deps.get(name) ?? []) {
      if (views.has(d) && !visit(d)) return false;
    }
    state.set(name, 'done');
    ordered.push(name);
    return true;
  };
  for (const name of views.keys()) {
    if (!visit(name)) {
      warnings.push(`entity '${name}': its node view depends on itself ` +
          `through derive_from; no node views are generated for the cycle`);
      for (const [n, s] of state) {
        if (s === 'visiting') {
          views.delete(n);
          planned.delete(n);
          state.set(n, 'done');
        }
      }
    }
  }

  // Rewrite the model: each planned entity reads its view.
  const rewritten = entities.map(e => {
    const p = planned.get(e.name);
    if (!p || !views.has(e.name)) return e;
    const own = new Set(e.fields.map(f => f.name));
    let fields: Field[] = e.fields.map(f => {
      const col = p.columns.get(f.name);
      if (col === undefined) return f;
      const out: Field = {...f, expression: col};
      delete out.importedExpression;
      delete out.importedDialect;
      return out;
    });
    // A derived entity's view holds its key alone: any other field it
    // declares has no column to read here.
    if (isDerivedEntity(e)) {
      const others = fields.filter(f => !p.columns.has(f.name));
      if (others.length) {
        warnings.push(`entity '${e.name}': derived from relationship '${
            e.hydration!.deriveFrom!.relationship}', so only its key is ` +
            `available; ${others.map(f => `'${f.name}'`).join(', ')} ` +
            `${others.length === 1 ? 'is' : 'are'} not deployed`);
      }
      fields = fields.filter(f => p.columns.has(f.name));
    }
    // An inherited field bound on a concrete supertype reads that
    // supertype's column; re-declare it here so it reads this view's.
    for (const f of p.resolved.fields) {
      const col = p.columns.get(f.name);
      if (col === undefined || own.has(f.name)) continue;
      const out: Field = {...f, expression: col};
      delete out.importedExpression;
      delete out.importedDialect;
      fields.push(out);
    }
    return {...e, dataSource: p.ref, fields};
  });

  // Resolve rules on directly bound entities become edge views.
  const edgeViews: GeneratedView[] = [];
  const edgePlan: string[] = [];
  const rewrittenByName = new Map(rewritten.map(e => [e.name, e]));
  const newRels = relationships.map(rel => {
    const src = declaredByName.get(rel.source.entity);
    if (!src || !isDirect(src) || !src.hydration?.resolve?.length) return rel;
    const rule = src.hydration.resolve.find(r => r.field === rel.source.columns[0]);
    if (!rule || resolveRelationship(working, src, rule.field) !== rel) {
      return rel;
    }
    const built = resolvedEdgeView(
        rel, rule.match, resolvedByName.get(src.name)!, rewrittenByName,
        declaredByName, resolvedByName, planned, target, warnings);
    if (!built) return rel;
    edgeViews.push(built.view);
    edgePlan.push(`edge view ${built.view.ref} (${rel.name}): ${
        rule.field} resolved to ${rel.destination.entity} by ${
        rule.match.join(' or ')}`);
    return {...rel, association: built.association};
  });

  if (!views.size && !edgeViews.length) return {model, views: [], plan: []};
  return {
    model: {...model, entities: rewritten, relationships: newRels},
    views: [...ordered.filter(n => views.has(n)).map(n => views.get(n)!),
            ...edgeViews],
    plan: [...ordered.filter(n => views.has(n)).map(n => plan.get(n)!),
           ...edgePlan],
  };
}

/**
 * Orders every view a BigQuery push creates before its graph: node views,
 * then vocabulary views, then edge views (resolved, vocabulary and derived
 * edges, which read the node and vocabulary views).
 */
export function orderGeneratedViews(
    nodeLowering: GeneratedView[], graphViews: GeneratedView[]): GeneratedView[] {
  const all = [...nodeLowering, ...graphViews];
  return [
    ...all.filter(v => v.kind === 'node'),
    ...all.filter(v => v.kind === 'vocabulary'),
    ...all.filter(v => v.kind === 'edge'),
  ];
}

function destinationNamer(model: SemanticModel, e: Entity):
    (field: string) => string | undefined {
  return field => resolveRelationship(model, e, field)?.destination.entity;
}

// The lookup source for resolving `rel`'s foreign key: the destination's
// members (a vocabulary), or its source table, read with its physical
// columns. Undefined (with a warning) when there is nothing to read.
function lookupSource(
    rel: Relationship, match: string[],
    declaredByName: Map<string, Entity>, resolvedByName: Map<string, Entity>,
    at: string, warnings: string[]): LookupSource|undefined {
  const destDeclared = declaredByName.get(rel.destination.entity);
  const destResolved = resolvedByName.get(rel.destination.entity);
  if (!destDeclared || !destResolved) return undefined;
  const key = destResolved.keys[0];
  // Key first, then the listed unique keys in order.
  const order = [...match.filter(m => m === key), ...match.filter(m => m !== key)]
                    .filter(m => isMatchableField(destResolved, m));
  if (!order.length) return undefined;
  const fieldOf = (n: string) => destResolved.fields.find(f => f.name === n);

  if (isVocabulary(destDeclared)) {
    const vocab = generatesVocabularyView(destResolved) ?
        withVocabularyBindings(destResolved) :
        destResolved;
    const column = (n: string): string|undefined => {
      const f = vocab.fields.find(x => x.name === n);
      const b = f ? fieldBinding(f) : undefined;
      return b !== undefined ? stripQualifier(b, vocab.name) : undefined;
    };
    if (generatesVocabularyView(destResolved)) {
      const cols = [key, ...order].map(column);
      if (cols.some(c => c === undefined)) return undefined;
      const unique = [...new Set(cols as string[])];
      const table = membersTable(destDeclared.members ?? [], unique);
      if (!table) return undefined;
      return {
        from: table,
        code: {expr: aliased('d', column(key)!), isText: true},
        matches: order.map(m => ({expr: aliased('d', column(m)!), isText: true})),
      };
    }
  }
  if (isDerivedEntity(destDeclared)) {
    warnings.push(`${at}: resolve against '${destDeclared.name}' is skipped: ` +
        `that entity is derived from a relationship, so its keys are the ` +
        `recorded values themselves`);
    return undefined;
  }
  if (hasNoSource(destDeclared)) {
    warnings.push(`${at}: resolve against '${destDeclared.name}' is skipped: ` +
        `that entity has no source to match against`);
    return undefined;
  }
  const physical = (n: string): string|undefined => {
    const f = fieldOf(n);
    const b = f ? fieldBinding(f) : undefined;
    return b !== undefined ? stripQualifier(b, destResolved.name) : undefined;
  };
  if ([key, ...order].some(n => physical(n) === undefined)) {
    warnings.push(`${at}: resolve against '${destDeclared.name}' is skipped: ` +
        `${[key, ...order].filter(n => physical(n) === undefined)
            .map(n => `'${n}'`).join(', ')} is not bound there`);
    return undefined;
  }
  return {
    from: fromTarget(destDeclared.dataSource),
    code: {expr: aliased('d', physical(key)!), isText: textual(fieldOf(key))},
    matches: order.map(
        m => ({expr: aliased('d', physical(m)!), isText: textual(fieldOf(m))})),
  };
}

// The date comparison a normalize rule applies on.
function normalizeCondition(
    rule: NormalizeRule, onExpr: string, onType: Field['type']): string {
  const bound = (rule.before ?? rule.after)!;
  const op = rule.before !== undefined ? '<' : '>=';
  const ts = isTimestampBound(bound);
  const hasOffset = /(Z|[+-]\d{2}(:?\d{2})?)$/.test(bound) && ts;
  if (onType === 'Date' && !ts) return `${onExpr} ${op} DATE '${bound}'`;
  if (onType === 'DateTimeTz') {
    return `${onExpr} ${op} TIMESTAMP '${bound}'`;
  }
  if (onType === 'DateTime' && !hasOffset) {
    return `${onExpr} ${op} DATETIME '${bound}'`;
  }
  return ts ? `CAST(${onExpr} AS TIMESTAMP) ${op} TIMESTAMP '${bound}'` :
              `CAST(${onExpr} AS DATE) ${op} DATE '${bound}'`;
}

function viewDescription(
    p: Planned, model: SemanticModel, sourceText: string): string {
  const clauses = hydrationClauses(p.entity, destinationNamer(model, p.entity));
  const keys = p.entity.keys.map(k => p.columns.get(k) ?? snakeCase(k));
  return [
    p.entity.description?.trim() ? sentence(p.entity.description) :
                                   `Entity ${p.entity.name}.`,
    `Key: ${keys.join(', ')}.`,
    clauses.length ? `Hydration: ${clauses.join('; ')}.` : undefined,
    sourceText,
    'Generated by kcmd from the semantic model; do not edit.',
  ].filter((s): s is string => !!s).join(' ');
}

function createView(ref: string, description: string, body: string[]): string {
  return [
    `CREATE OR REPLACE VIEW \`${ref}\``,
    `OPTIONS (description = ${sqlString(description)}) AS`,
    ...body,
  ].join('\n');
}

// The node view over an entity's own source table.
function tableViewSql(
    p: Planned, model: SemanticModel, declaredByName: Map<string, Entity>,
    resolvedByName: Map<string, Entity>,
    warnings: string[]): {ddl: string; deps: string[]}|undefined {
  const e = p.resolved;
  const at = `entity '${e.name}'`;
  const fieldOf = (n: string) => e.fields.find(f => f.name === n);
  const local = (f: Field) => stripQualifier(fieldBinding(f)!, e.name);
  const exprs = new Map<string, string>();
  for (const f of e.fields) {
    if (p.columns.has(f.name)) exprs.set(f.name, aliased('t', local(f)));
  }
  const h = p.entity.hydration;

  // A column the hydration names: a field (its column) or a source column.
  const columnRef = (name: string): {expr: string; type: Field['type']} => {
    const f = fieldOf(name);
    if (f && fieldBinding(f) !== undefined) {
      return {expr: aliased('t', local(f)), type: f.type};
    }
    const byColumn = e.fields.find(
        x => fieldBinding(x) !== undefined && local(x) === name);
    return {expr: `t.${quoteIfReserved(name)}`, type: byColumn?.type};
  };

  for (const rule of h?.normalize ?? []) {
    const current = exprs.get(rule.field);
    if (current === undefined) {
      warnings.push(`${at}: hydration.normalize on '${rule.field}' is ` +
          `skipped: the field is not bound`);
      continue;
    }
    const onName = rule.on ?? h?.grain?.latestBy;
    if (onName === undefined) continue;  // checkHydration rejects this
    const on = columnRef(onName);
    const factor = rule.divideBy !== undefined ? `/ ${rule.divideBy}` :
                                                 `* ${rule.multiplyBy}`;
    exprs.set(
        rule.field,
        `IF(${normalizeCondition(rule, on.expr, on.type)}, ${current} ${
            factor}, ${current})`);
  }

  const joins: string[] = [];
  (h?.resolve ?? []).forEach(rule => {
    const current = exprs.get(rule.field);
    const ctx = `${at}: hydration.resolve on '${rule.field}'`;
    if (current === undefined) {
      warnings.push(`${ctx} is skipped: the field is not bound`);
      return;
    }
    const rel = resolveRelationship(model, p.entity, rule.field);
    if (!rel) {
      warnings.push(`${ctx} is skipped: no relationship joins on it`);
      return;
    }
    const src = lookupSource(
        rel, rule.match, declaredByName, resolvedByName, ctx, warnings);
    if (!src) return;
    const alias = `r${joins.length}`;
    const field = fieldOf(rule.field);
    joins.push(
        `LEFT JOIN ${lookupSql(src, '')} AS ${alias}\n  ON ${alias}._kcmd_match = ${
            normalized(aliased('t', local(field!)), textual(field))}`);
    exprs.set(rule.field, `COALESCE(${alias}._kcmd_code, ${current})`);
  });

  const select = [...p.columns.entries()].map(([fieldName, col]) => {
    const expr = exprs.get(fieldName)!;
    return expr === `t.${quoteIfReserved(col)}` ? expr :
                                                  `${expr} AS ${quoteIfReserved(col)}`;
  });
  const body = [
    'SELECT',
    select.map(s => `  ${s}`).join(',\n'),
    `FROM ${fromTarget(p.entity.dataSource)} AS t`,
    ...joins,
  ];
  if (h?.grain) {
    const partition = p.entity.keys.map(k => exprs.get(k) ?? `t.${quoteIfReserved(snakeCase(k))}`);
    const order = [
      ...(h.grain.latestBy !== undefined ?
              [`${columnRef(h.grain.latestBy).expr} DESC`] :
              []),
      'FARM_FINGERPRINT(TO_JSON_STRING(t))',
    ];
    body.push(`QUALIFY ROW_NUMBER() OVER (PARTITION BY ${
        partition.join(', ')} ORDER BY ${order.join(', ')}) = 1`);
  }
  const ddl = createView(
      p.ref, viewDescription(p, model, `Source: ${shortSource(p.entity.dataSource)}.`),
      body);
  return {ddl, deps: []};
}

// The node view of a derived entity: the distinct foreign-key values of its
// relationship, read from the relationship's source entity (its node view
// when it has one).
function derivedViewSql(
    p: Planned, model: SemanticModel, planned: Map<string, Planned>,
    resolvedByName: Map<string, Entity>,
    warnings: string[]): {ddl: string; deps: string[]}|undefined {
  const at = `entity '${p.entity.name}'`;
  const relName = p.entity.hydration!.deriveFrom!.relationship;
  const rel = (model.relationships ?? []).find(r => r.name === relName);
  if (!rel || rel.source.columns.length !== 1) {
    warnings.push(`${at}: hydration.derive_from relationship '${relName}' ` +
        `is not available; the entity has no rows to read`);
    return undefined;
  }
  const fk = rel.source.columns[0];
  const srcName = rel.source.entity;
  const srcView = planned.get(srcName);
  let from: string;
  let column: string;
  let deps: string[] = [];
  if (srcView && srcView.columns.has(fk)) {
    from = `\`${srcView.ref}\``;
    column = srcView.columns.get(fk)!;
    deps = [srcName];
  } else {
    const src = resolvedByName.get(srcName);
    const f = src?.fields.find(x => x.name === fk);
    const b = f ? fieldBinding(f) : undefined;
    if (!src || hasNoSource(src) || b === undefined) {
      warnings.push(`${at}: hydration.derive_from reads '${srcName}.${fk}', ` +
          `which is not bound; the entity has no rows to read`);
      return undefined;
    }
    from = fromTarget(src.dataSource);
    column = stripQualifier(b, src.name);
  }
  const keyCol = p.columns.get(p.entity.keys[0]) ?? snakeCase(p.entity.keys[0]);
  const read = aliased('s', column);
  const body = [
    `SELECT DISTINCT ${read} AS ${quoteIfReserved(keyCol)}`,
    `FROM ${from} AS s`,
    `WHERE ${read} IS NOT NULL`,
  ];
  const ddl = createView(
      p.ref,
      viewDescription(
          p, model,
          `Source: the distinct ${fk} of ${srcName} (relationship ${relName}).`),
      body);
  return {ddl, deps};
}

// The edge view for a resolve rule on a directly bound entity: each source
// row paired with the destination key its foreign key resolves to.
function resolvedEdgeView(
    rel: Relationship, match: string[], src: Entity,
    rewrittenByName: Map<string, Entity>, declaredByName: Map<string, Entity>,
    resolvedByName: Map<string, Entity>, planned: Map<string, Planned>,
    target: ViewTarget, warnings: string[]):
    {view: GeneratedView; association: NonNullable<Relationship['association']>}|
    undefined {
  const at = `relationship '${rel.name}'`;
  if (hasNoSource(src)) return undefined;
  const lookup =
      lookupSource(rel, match, declaredByName, resolvedByName, at, warnings);
  if (!lookup) return undefined;
  const dest = rewrittenByName.get(rel.destination.entity);
  if (!dest) return undefined;
  const physical = (n: string): string => {
    const f = src.fields.find(x => x.name === n);
    const b = f ? fieldBinding(f) : undefined;
    return b !== undefined ? stripQualifier(b, src.name) : n;
  };
  const name = edgeViewName(rel.name);
  const ref = viewRef(name, target);
  const sourceKeys = src.keys.map(physical);
  const sourceColumns = sourceKeys.map(c => `source_${outputName(c)}`);
  const destKey = dest.keys[0];
  const destColumn = `target_${outputName(
      planned.has(dest.name) ? snakeCase(destKey) :
                               physicalOf(dest, destKey))}`;
  const fkField = src.fields.find(f => f.name === rel.source.columns[0]);
  const description = `Edge ${rel.name} (${rel.source.entity} -> ${
      rel.destination.entity}): each ${rel.source.entity} row paired with the ${
      rel.destination.entity} whose ${match.join(' or ')} matches its ${
      rel.source.columns[0]} (case-insensitive, trimmed). Generated by kcmd ` +
      `from the semantic model; do not edit.`;
  const ddl = createView(ref, description, [
    `SELECT ${sourceKeys.map((c, i) => `${aliased('s', c)} AS ${sourceColumns[i]}`)
                  .join(', ')}, r._kcmd_code AS ${destColumn}`,
    `FROM ${fromTarget(src.dataSource)} AS s`,
    `JOIN ${lookupSql(lookup, '')} AS r`,
    `  ON r._kcmd_match = ${
        normalized(aliased('s', physical(rel.source.columns[0])), textual(fkField))}`,
    `WHERE r._kcmd_code IS NOT NULL`,
  ]);
  return {
    view: {name, ref, kind: 'edge', ddl, element: rel.name},
    association: {
      dataSource: ref,
      keys: [...sourceColumns, destColumn],
      sourceColumns,
      destinationColumns: [destColumn],
    },
  };
}

function physicalOf(entity: Entity, fieldName: string): string {
  const f = entity.fields.find(x => x.name === fieldName);
  const b = f ? fieldBinding(f) : undefined;
  return b !== undefined ? stripQualifier(b, entity.name) : fieldName;
}

// An output column name derived from a physical column.
function outputName(column: string): string {
  const cleaned =
      column.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'key';
}

/** The table name of a node view (exported for messages and tests). */
export function nodeViewName(entityName: string): string {
  return snakeCase(entityName);
}

// Re-exported for callers that only need the view reference.
export {tableName};
