// Defined (virtual) entities: subsets of a parent entity characterized by a
// membership predicate rather than a table of their own (see
// ir.Entity.definition).
//
// The OWL defined class `WonOpportunity ≡ Opportunity ⊓ (salesStage = '5_won')`
// is not a table and never will be: every won opportunity is a row of the
// opportunity table, picked out by a predicate. Modeling it as an entity with
// `extends: [Opportunity]` and no `source` (today's OWL import) leaves the
// predicate behind and produces an entity no graph leg can bind; modeling it as
// a boolean field loses the class. A defined entity keeps both: the catalog
// sees a first-class concept with its definition, and a graph leg lowers it
// onto the table that actually holds its rows.
//
// Vocabulary used throughout:
//   - the PARENT of a defined entity D is its single `extends` entry;
//   - its BASE is the nearest non-defined entity up the parent chain (the
//     parent itself unless the parent is defined too -- `MegaDeal` refines
//     `HighValueOpportunity` which refines `Opportunity`);
//   - its MEMBERSHIP is the conjunction of every definition on the chain from
//     D up to (excluding) the base: `(amount >= 1000) AND (amount >= 20000)`;
//   - its MEMBERSHIP PROPERTY is the boolean `is<Name>` the graph legs add to
//     the base (`isWonOpportunity`), so `MATCH (o:Opportunity) WHERE
//     o.isWonOpportunity` answers "won opportunities".
//
// Definitions are SQL boolean expressions in the BigQuery dialect, like metric
// expressions, over the lineage's field NAMES (optionally qualified by the
// defined entity, its parent chain or the base's ancestors). Lowering rewrites
// those names into the base's physical bindings, so a field bound to
// `sales_stage` turns `salesStage = '5_won'` into `sales_stage = '5_won'`.

import {Entity, fieldBinding, SemanticModel} from './ir';
import {resolveInheritance} from './resolve_inheritance';
import {referencedEntityNames, referencedIdentifiers, rewriteFieldRefs, stripQualifier} from './sql_expr_utils';
import {isReservedKeyword, isSimpleIdentifier} from './sql_identifiers';

/** Whether `e` is a defined (virtual) entity. */
export function isDefinedEntity(e: Entity): boolean {
  return e.definition !== undefined;
}

/**
 * The boolean property a graph leg adds to a defined entity's base:
 * `WonOpportunity` -> `isWonOpportunity`.
 */
export function membershipPropertyName(name: string): string {
  return `is${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

// Words that may appear bare in a boolean expression without naming a field:
// GoogleSQL reserved keywords (AND, IN, IS, NULL, TRUE, CASE, ...) plus the
// non-reserved type names, date parts and pseudo-namespaces that appear in
// CAST/EXTRACT/DATE_DIFF arguments and SAFE.-prefixed calls. Compared
// uppercase.
const NON_FIELD_WORDS = new Set<string>([
  // Types (CAST(x AS STRING), SAFE_CAST, typed literals DATE '2024-01-01').
  'STRING', 'INT64', 'INT', 'INTEGER', 'SMALLINT', 'BIGINT', 'TINYINT',
  'BYTEINT', 'FLOAT64', 'FLOAT', 'NUMERIC', 'BIGNUMERIC', 'DECIMAL',
  'BIGDECIMAL', 'BOOL', 'BOOLEAN', 'BYTES', 'DATE', 'DATETIME', 'TIMESTAMP',
  'TIME', 'JSON', 'GEOGRAPHY', 'RANGE',
  // Date parts (EXTRACT(YEAR FROM d), DATE_DIFF(a, b, DAY)).
  'YEAR', 'QUARTER', 'MONTH', 'WEEK', 'ISOWEEK', 'ISOYEAR', 'DAY',
  'DAYOFWEEK', 'DAYOFYEAR', 'HOUR', 'MINUTE', 'SECOND', 'MILLISECOND',
  'MICROSECOND', 'NANOSECOND', 'SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY',
  'THURSDAY', 'FRIDAY', 'SATURDAY',
  // SAFE.FUNC(...) namespace, and literals the reserved list leaves out.
  'SAFE', 'NAN', 'INF',
]);

function isNonFieldWord(token: string): boolean {
  return isReservedKeyword(token) || NON_FIELD_WORDS.has(token.toUpperCase());
}

/** A defined entity's resolved position in the hierarchy. */
export interface DefinedEntityInfo {
  name: string;
  parent: string;
  // The nearest non-defined ancestor: the entity the defined entity's rows
  // live in.
  base: string;
  // The defined entities from this one up to (excluding) the base,
  // nearest-first: [MegaDeal, HighValueOpportunity].
  chain: string[];
  // The membership predicate: every definition on `chain`, outermost first,
  // each with its own entity-name qualifiers stripped, joined by AND. A single
  // definition is returned as written (no extra parentheses).
  membership: string;
}

/** Outcome of resolving every defined entity's parent chain. */
export interface DefinedResolution {
  infos: Map<string, DefinedEntityInfo>;
  // Structural problems (no parent, several, unknown, cycle), one message per
  // defined entity, keyed by its name. An entity listed here has no info.
  problems: Map<string, string>;
}

/**
 * Resolves each defined entity's parent, base and membership predicate. Never
 * throws: structural problems are returned per entity so a caller can report
 * (validate) or skip-and-warn (the graph legs).
 */
export function resolveDefinedEntities(model: SemanticModel):
    DefinedResolution {
  const entities = model.entities ?? [];
  const byName = new Map(entities.map(e => [e.name, e]));
  const infos = new Map<string, DefinedEntityInfo>();
  const problems = new Map<string, string>();

  for (const d of entities) {
    if (!isDefinedEntity(d)) continue;
    const chain: string[] = [];
    let current: Entity = d;
    let problem: string|undefined;
    for (;;) {
      if (chain.includes(current.name)) {
        problem = `its parent chain loops back to '${current.name}' (${
            [...chain, current.name].join(' -> ')})`;
        break;
      }
      chain.push(current.name);
      const parents = current.extends ?? [];
      const who = current === d ? '' : ` (via defined parent '${current.name}')`;
      if (parents.length === 0) {
        problem = `a defined entity must extend exactly one parent entity${
            who}, and none is declared`;
        break;
      }
      if (parents.length > 1) {
        problem = `a defined entity must extend exactly one parent entity${
            who}, but it extends ${parents.map(p => `'${p}'`).join(', ')}`;
        break;
      }
      const parent = byName.get(parents[0]);
      if (!parent) {
        problem =
            `its parent '${parents[0]}'${who} is not an entity in the model`;
        break;
      }
      if (!isDefinedEntity(parent)) {
        const parts = chain.slice().reverse().map(n => {
          const e = byName.get(n)!;
          return qualifiedFree(e.definition!.expression, e, byName);
        });
        infos.set(d.name, {
          name: d.name,
          parent: d.extends![0],
          base: parent.name,
          chain,
          membership: parts.length === 1 ? parts[0] :
                                           parts.map(p => `(${p})`).join(' AND '),
        });
        break;
      }
      current = parent;
    }
    if (problem) problems.set(d.name, problem);
  }
  return {infos, problems};
}

// A definition with qualifiers naming the defined entity itself or any entity
// on its parent chain (base and the base's ancestors included) stripped, so it
// reads as table-local field names.
function qualifiedFree(
    expression: string, entity: Entity, byName: Map<string, Entity>): string {
  let out = expression.trim();
  for (const name of lineageNames(entity, byName)) {
    out = stripQualifier(out, name);
  }
  return out;
}

// The entity and all of its transitive ancestors that exist in the model
// (breadth-first, cycle-safe).
function lineageNames(entity: Entity, byName: Map<string, Entity>): string[] {
  const seen = new Set<string>([entity.name]);
  const queue = [...(entity.extends ?? [])];
  while (queue.length) {
    const n = queue.shift()!;
    if (seen.has(n) || !byName.has(n)) continue;
    seen.add(n);
    queue.push(...(byName.get(n)!.extends ?? []));
  }
  return [...seen];
}

// The bare names a membership predicate reads as fields: identifiers that are
// not keywords, type names or function names.
export function membershipFieldRefs(membership: string): string[] {
  return referencedIdentifiers(membership).filter(t => !isNonFieldWord(t));
}

/**
 * Push-time checks for defined entities. Returns one message per violation
 * (without the model/document prefix, which the caller adds).
 *
 * `fieldsPruned`: the caller dropped fields the binding profile leaves
 * unbound, so a reference to a field the base no longer carries is the
 * profile's doing; the graph leg warns and skips that membership property
 * instead, and the unknown-field check stands down.
 */
export function validateDefinedEntities(
    model: SemanticModel, opts: {fieldsPruned?: boolean} = {}): string[] {
  const entities = model.entities ?? [];
  if (!entities.some(isDefinedEntity)) return [];
  const errors: string[] = [];
  const byName = new Map(entities.map(e => [e.name, e]));
  const {infos, problems} = resolveDefinedEntities(model);

  // Resolved (flattened) fields, for the reference and collision checks. An
  // `extends` naming no entity makes resolution throw; validate reports that
  // separately, so the field checks just stand down.
  let resolved: Map<string, Entity>|undefined;
  try {
    resolved = new Map(
        (resolveInheritance(model).model.entities ?? []).map(e => [e.name, e]));
  } catch {
    resolved = undefined;
  }

  const membershipOwners = new Map<string, string>();
  for (const d of entities) {
    if (isDefinedEntity(d)) {
      const label = `defined entity '${d.name}'`;
      const problem = problems.get(d.name);
      if (problem) errors.push(`${label}: ${problem}.`);
      if (d.dataSource) {
        errors.push(`${label} has a source ('${
            d.dataSource}'); a defined entity is a subset of its parent's ` +
                    `rows and has no table of its own. Remove the source, or ` +
                    `drop 'defined' to make it a table-backed entity.`);
      }
      if (d.keys.length || d.uniqueKeys?.length) {
        errors.push(`${label} declares keys; a defined entity shares its ` +
                    `parent's identity. Remove 'primary_key'/'unique_keys'.`);
      }
      if (d.fields.length) {
        errors.push(`${label} declares fields (${
            d.fields.map(f => f.name)
                .join(', ')}); a defined entity has exactly its ` +
                    `parent's fields. Declare them on the parent, or drop ` +
                    `'defined'.`);
      }
      const info = infos.get(d.name);
      if (!info) continue;

      // Qualifiers naming an entity off the lineage: a definition is evaluated
      // on one row of the base, so it cannot reach another entity's table.
      const foreign = referencedEntityNames(
          info.membership,
          entities.map(e => e.name).filter(n => n !== d.name));
      if (foreign.length) {
        errors.push(`${label}: its definition references ${
            foreign.map(n => `'${n}'`).join(', ')}, which is not on its ` +
                    `parent chain; a definition may only read fields of ` +
                    `'${info.base}' (one row, no joins).`);
      }

      const base = resolved?.get(info.base);
      if (base && !opts.fieldsPruned) {
        const known = new Set(base.fields.map(f => f.name));
        const unknown =
            membershipFieldRefs(info.membership).filter(r => !known.has(r));
        if (unknown.length) {
          const lower = new Map(base.fields.map(f => [f.name.toLowerCase(), f.name]));
          const hints = unknown.map(u => {
            const near = lower.get(u.toLowerCase());
            return near ? `'${u}' (did you mean '${near}'?)` : `'${u}'`;
          });
          errors.push(`${label}: its definition references ${
              hints.join(', ')}, which ${
              unknown.length === 1 ? 'is not a field' :
                                     'are not fields'} of '${info.base}'.`);
        }
      }

      // The membership property must not shadow a field of the base or of
      // any entity that inherits the base (the property flows down to them),
      // and two defined entities must not claim the same one. GoogleSQL
      // property names compare case-insensitively.
      const prop = membershipPropertyName(d.name);
      const key = prop.toLowerCase();
      const other = membershipOwners.get(key);
      if (other) {
        errors.push(`${label} and defined entity '${other}' both lower to ` +
                    `the membership property '${prop}'; rename one.`);
      } else {
        membershipOwners.set(key, d.name);
      }
      if (!isSimpleIdentifier(prop)) {
        errors.push(`${label}: its membership property '${
            prop}' is not a simple identifier; rename the entity.`);
      }
      if (resolved) {
        for (const e of resolved.values()) {
          if (isDefinedEntity(e)) continue;
          if (e.name !== info.base && !(e.extends ?? []).includes(info.base))
            continue;
          const clash = e.fields.find(f => f.name.toLowerCase() === key);
          if (clash) {
            errors.push(`${label} lowers to the boolean property '${
                prop}', which collides with field '${e.name}.${
                clash.name}'; rename the field or the defined entity.`);
            break;
          }
        }
      }
    } else {
      // A defined entity is a filter, not a supertype: nothing may inherit
      // from it (its "fields" are the base's, and it has no table to anchor a
      // subtype's label).
      for (const p of d.extends ?? []) {
        const parent = byName.get(p);
        if (parent && isDefinedEntity(parent)) {
          errors.push(`entity '${d.name}' extends defined entity '${
              p}'; a defined entity cannot be a supertype. Make '${
              d.name}' defined too, or have it extend '${
              infos.get(p)?.base ?? p}' instead.`);
        }
      }
    }
  }
  return errors;
}

/**
 * Lowers defined entities for a graph leg (BigQuery / Spanner): removes each
 * one from the model and adds its membership property `is<Name>` (a boolean
 * computed from the definition) to its base. Returns the model unchanged --
 * the same object -- when it declares no defined entity, so existing output is
 * byte-identical.
 *
 * Lowering, per defined entity D with base B:
 *   - concrete B: B gains own field `isD = COALESCE(<membership over B's
 *     bindings>, FALSE)`; inheritance flattening carries it to B's
 *     descendants, exactly like any other field of B;
 *   - abstract B: B gains an UNBOUND `isD` (the shared label's signature), and
 *     each concrete descendant gains its own bound `isD` computed from its own
 *     bindings (or `CAST(NULL AS BOOL)`, warned, when it does not bind every
 *     field the definition reads).
 * A defined entity forms no node table, so B stays a leaf and its measures are
 * unaffected. Relationships with a defined endpoint are re-pointed at the base
 * (warned): the edge's join columns are the base's anyway. Metrics attached to
 * a defined entity are dropped (warned): MEASURE has no row filter.
 */
export function lowerDefinedEntities(
    model: SemanticModel, warnings: string[]): SemanticModel {
  const entities = model.entities ?? [];
  if (!entities.some(isDefinedEntity)) return model;

  const {infos, problems} = resolveDefinedEntities(model);
  for (const [name, problem] of problems) {
    warnings.push(`defined entity '${name}' is skipped: ${problem}`);
  }
  const definedNames = new Set(entities.filter(isDefinedEntity).map(e => e.name));
  const clone: SemanticModel = structuredClone(model);
  clone.entities = (clone.entities ?? []).filter(e => !definedNames.has(e.name));
  for (const e of clone.entities) {
    const kept = (e.extends ?? []).filter(p => !definedNames.has(p));
    if (kept.length !== (e.extends ?? []).length) {
      warnings.push(`entity '${e.name}' extends a defined entity (${
          (e.extends ?? [])
              .filter(p => definedNames.has(p))
              .join(', ')}); a defined entity forms no label, so that ` +
                    `supertype is dropped`);
      if (kept.length) {
        e.extends = kept;
      } else {
        delete e.extends;
      }
    }
  }

  // Relationships: re-point a defined endpoint at its base.
  for (const rel of clone.relationships ?? []) {
    for (const end of [rel.source, rel.destination]) {
      if (!definedNames.has(end.entity)) continue;
      const base = infos.get(end.entity)?.base;
      if (base) {
        warnings.push(`relationship '${rel.name}': endpoint '${
            end.entity}' is a defined entity (no node table); the edge ` +
                      `connects its base '${base}' instead`);
        end.entity = base;
      }
    }
  }
  clone.relationships = (clone.relationships ?? []).filter(rel => {
    const dead = [rel.source.entity, rel.destination.entity].find(
        n => definedNames.has(n));
    if (dead) {
      warnings.push(`relationship '${rel.name}' is skipped: endpoint '${
          dead}' is a defined entity that could not be resolved`);
    }
    return !dead;
  });

  // Metrics: a MEASURE cannot carry a row filter.
  clone.metrics = (clone.metrics ?? []).filter(m => {
    if (m.entity && definedNames.has(m.entity)) {
      warnings.push(`metric '${m.name}' is skipped: it attaches to defined ` +
                    `entity '${m.entity}', which has no node table (a ` +
                    `MEASURE cannot filter rows); define it on '${
                        infos.get(m.entity)?.base ?? m.entity}' with an ` +
                    `explicit condition instead`);
      return false;
    }
    return true;
  });

  // Bindings come from the resolved (flattened) view of the model without the
  // defined entities; the membership fields are added to the UNRESOLVED clone
  // so the leg's own resolveInheritance flattens them like any other field.
  const resolvedByName = new Map(
      (resolveInheritance(clone).model.entities ?? []).map(e => [e.name, e]));
  const cloneByName = new Map(clone.entities.map(e => [e.name, e]));

  for (const d of entities) {
    const info = infos.get(d.name);
    if (!info) continue;
    const base = cloneByName.get(info.base);
    const resolvedBase = resolvedByName.get(info.base);
    if (!base || !resolvedBase) continue;
    const prop = membershipPropertyName(d.name);
    const label = `defined entity '${d.name}'`;
    const clash = [...resolvedByName.values()].find(
        e => (e.name === info.base || (e.extends ?? []).includes(info.base)) &&
            e.fields.some(f => f.name.toLowerCase() === prop.toLowerCase()));
    if (clash) {
      warnings.push(`${label} is skipped: its membership property '${
          prop}' collides with a field of '${clash.name}'`);
      continue;
    }
    const refs = membershipFieldRefs(info.membership);
    const description = membershipDescription(d, info);

    if (!base.abstract) {
      const expr = membershipExpression(info.membership, refs, resolvedBase);
      if (typeof expr !== 'string') {
        warnings.push(`${label} is skipped: its definition reads ${
            expr.missing.map(m => `'${m}'`)
                .join(', ')}, which '${info.base}' does not bind`);
        continue;
      }
      base.fields.push(
          {name: prop, type: 'Boolean', expression: expr, description});
      continue;
    }

    // Abstract base: the base carries the property unbound (the shared
    // label's signature); each concrete descendant binds it from its own
    // columns.
    base.fields.push({name: prop, type: 'Boolean', description});
    for (const e of clone.entities) {
      if (e.abstract) continue;
      const resolved = resolvedByName.get(e.name);
      if (!resolved || !(resolved.extends ?? []).includes(info.base)) continue;
      const expr = membershipExpression(info.membership, refs, resolved);
      if (typeof expr !== 'string') {
        warnings.push(`${label}: '${e.name}' does not bind ${
            expr.missing.map(m => `'${m}'`)
                .join(', ')}, so its '${prop}' is NULL`);
      }
      e.fields.push({
        name: prop,
        type: 'Boolean',
        expression: typeof expr === 'string' ? expr : 'CAST(NULL AS BOOL)',
        description,
      });
    }
  }
  return clone;
}

// The membership predicate over `entity`'s physical bindings, made two-valued
// (a NULL comparison is "not a member"), or the referenced names it does not
// bind.
function membershipExpression(
    membership: string, refs: string[], entity: Entity): string|
    {missing: string[]} {
  const bindings = new Map<string, string>();
  for (const f of entity.fields) {
    const b = fieldBinding(f);
    if (b !== undefined) bindings.set(f.name, stripQualifier(b, entity.name));
  }
  const missing = refs.filter(r => !bindings.has(r));
  if (missing.length) return {missing};
  return `COALESCE(${rewriteFieldRefs(membership, bindings)}, FALSE)`;
}

// The membership property's description: what the class means, then exactly
// how membership is decided, so a reader of the graph schema sees both.
function membershipDescription(d: Entity, info: DefinedEntityInfo): string {
  const parts = [
    d.description?.trim(),
    d.definition?.description?.trim(),
    `True when this ${info.base} is ${/^[aeiou]/i.test(d.name) ? 'an' : 'a'} ${
        d.name}: ${info.membership}.`,
  ].filter((p): p is string => !!p);
  return parts.join(' ');
}
