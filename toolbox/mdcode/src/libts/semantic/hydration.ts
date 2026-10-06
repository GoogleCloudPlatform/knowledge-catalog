// Hydration: how a binding reshapes its physical source into the entity the
// model declares (see ir.Entity.hydration / ir.Entity.mode).
//
// A binding profile maps each entity to a table and each field to a column.
// Real tables rarely match the model exactly: a key repeats across versions,
// a money column changed units on a known date, a foreign key is recorded
// sometimes as a code and sometimes as a name, an entity the model declares
// has no table of its own. The profile states each deviation with one rule
// from a CLOSED vocabulary, never with SQL, so the binding stays declarative
// and governable:
//
//   hydration:
//     grain:       { latest_by: created_at }      # or { deterministic: true }
//     normalize:   [{ field: wonAmount, before: "2024-03-25", divide_by: 100 }]
//     resolve:     [{ field: homeMarketUnit, match: [marketUnitCode, unitName] }]
//     derive_from: { relationship: allianceWith }
//   mode: view                                     # or direct
//
// Each rule compiles to one documented SQL shape in the entity's node view
// (node_views.ts). This module owns the vocabulary: the document validator
// (shared by the profile merge and the loader, so both reject the same
// documents with the same words), the document <-> IR mapping, the static
// cross-reference checks, and the one-line human summary that node-view
// descriptions and catalog entries carry.

import {Entity, EntityHydration, Field, NormalizeRule, Relationship, ResolveRule, SemanticModel} from './ir';
import {declaredConceptFields} from './resolve_inheritance';
import {snakeCase} from './generated_views';
import {isSimpleIdentifier} from './sql_identifiers';

/** The rules a `hydration` block may carry; anything else is rejected. */
export const HYDRATION_RULES = ['grain', 'normalize', 'resolve', 'derive_from'] as const;

/** The values of an entity's `mode`. */
export const BINDING_MODES = ['view', 'direct'] as const;

const GRAIN_KEYS = ['latest_by', 'deterministic'];
const NORMALIZE_KEYS = ['field', 'before', 'after', 'divide_by', 'multiply_by', 'on'];
const RESOLVE_KEYS = ['field', 'match'];
const DERIVE_KEYS = ['relationship'];

// An ISO date (2024-03-25) or timestamp (2024-03-25T10:00:00Z, with a space
// or a T, optional seconds, fraction and offset).
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIMESTAMP =
    /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)?$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function unknownKeys(obj: Record<string, unknown>, allowed: string[]): string[] {
  return Object.keys(obj).filter(k => !allowed.includes(k));
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * A date bound as written: an ISO date or timestamp string. A YAML 1.1 reader
 * may hand an unquoted date over as a Date; it is accepted and written back
 * as the ISO date (or timestamp, when it carries a time).
 */
export function dateBound(v: unknown): string|undefined {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const iso = v.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
  }
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return ISO_DATE.test(s) || ISO_TIMESTAMP.test(s) ? s : undefined;
}

/** Whether a date bound carries a time of day (else it is a date). */
export function isTimestampBound(bound: string): boolean {
  return !ISO_DATE.test(bound);
}

/**
 * Validates a `hydration` block as written in a document (snake_case keys)
 * and returns one message per violation (empty when it is well formed). The
 * block is CLOSED: an unknown rule or key is an error, as arbitrary SQL in a
 * profile is. Only shape is checked here; whether the names resolve against
 * the model is checkHydration's job.
 */
export function hydrationDocErrors(doc: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(doc)) {
    return [`'hydration' must be a mapping of rules (${HYDRATION_RULES.join(', ')})`];
  }
  for (const k of unknownKeys(doc, [...HYDRATION_RULES])) {
    errors.push(`'hydration' sets '${k}', which is not a hydration rule; a ` +
        `hydration block accepts only ${HYDRATION_RULES.join(', ')} (no SQL)`);
  }
  if (doc.grain !== undefined) {
    const g = doc.grain;
    if (!isObject(g)) {
      errors.push(`'hydration.grain' must be { latest_by: <column> } or ` +
          `{ deterministic: true }`);
    } else {
      for (const k of unknownKeys(g, GRAIN_KEYS)) {
        errors.push(`'hydration.grain' sets '${k}'; grain accepts only ` +
            `latest_by or deterministic`);
      }
      const hasLatest = g.latest_by !== undefined;
      const hasDet = g.deterministic !== undefined;
      if (hasLatest === hasDet) {
        errors.push(`'hydration.grain' must set exactly one of latest_by ` +
            `(a date/time column) or deterministic: true`);
      }
      if (hasLatest &&
          !(nonEmptyString(g.latest_by) && isSimpleIdentifier(g.latest_by))) {
        errors.push(`'hydration.grain.latest_by' must name one column (a bare ` +
            `identifier), not an expression`);
      }
      if (hasDet && g.deterministic !== true) {
        errors.push(`'hydration.grain.deterministic' must be true`);
      }
    }
  }
  if (doc.normalize !== undefined) {
    if (!Array.isArray(doc.normalize) || !doc.normalize.length) {
      errors.push(`'hydration.normalize' must be a non-empty list of rules`);
    } else {
      doc.normalize.forEach((r, i) => {
        const at = `'hydration.normalize[${i}]'`;
        if (!isObject(r)) {
          errors.push(`${at} must be a mapping`);
          return;
        }
        for (const k of unknownKeys(r, NORMALIZE_KEYS)) {
          errors.push(`${at} sets '${k}'; normalize accepts only ${
              NORMALIZE_KEYS.join(', ')}`);
        }
        if (!nonEmptyString(r.field)) errors.push(`${at} needs 'field'`);
        if ((r.before === undefined) === (r.after === undefined)) {
          errors.push(`${at} must set exactly one of before or after`);
        }
        for (const k of ['before', 'after'] as const) {
          if (r[k] !== undefined && dateBound(r[k]) === undefined) {
            errors.push(`${at}.${k} must be an ISO date (2024-03-25) or ` +
                `timestamp (2024-03-25T00:00:00Z)`);
          }
        }
        if ((r.divide_by === undefined) === (r.multiply_by === undefined)) {
          errors.push(`${at} must set exactly one of divide_by or multiply_by`);
        }
        for (const k of ['divide_by', 'multiply_by'] as const) {
          const n = r[k];
          if (n !== undefined &&
              !(typeof n === 'number' && Number.isFinite(n) && n > 0)) {
            errors.push(`${at}.${k} must be a number > 0`);
          }
        }
        if (r.on !== undefined &&
            !(nonEmptyString(r.on) && isSimpleIdentifier(r.on))) {
          errors.push(`${at}.on must name one date column (a bare identifier)`);
        }
      });
    }
  }
  if (doc.resolve !== undefined) {
    if (!Array.isArray(doc.resolve) || !doc.resolve.length) {
      errors.push(`'hydration.resolve' must be a non-empty list of rules`);
    } else {
      doc.resolve.forEach((r, i) => {
        const at = `'hydration.resolve[${i}]'`;
        if (!isObject(r)) {
          errors.push(`${at} must be a mapping`);
          return;
        }
        for (const k of unknownKeys(r, RESOLVE_KEYS)) {
          errors.push(`${at} sets '${k}'; resolve accepts only field and match`);
        }
        if (!nonEmptyString(r.field)) errors.push(`${at} needs 'field'`);
        if (!Array.isArray(r.match) || !r.match.length ||
            !r.match.every(nonEmptyString)) {
          errors.push(`${at}.match must be a non-empty list of field names ` +
              `(the destination's key and/or unique keys)`);
        }
      });
    }
  }
  if (doc.derive_from !== undefined) {
    const d = doc.derive_from;
    if (!isObject(d)) {
      errors.push(`'hydration.derive_from' must be { relationship: <name> }`);
    } else {
      for (const k of unknownKeys(d, DERIVE_KEYS)) {
        errors.push(`'hydration.derive_from' sets '${k}'; derive_from ` +
            `accepts only relationship`);
      }
      if (!nonEmptyString(d.relationship)) {
        errors.push(`'hydration.derive_from' needs 'relationship'`);
      }
    }
    const others = HYDRATION_RULES.filter(
        r => r !== 'derive_from' && doc[r] !== undefined);
    if (others.length) {
      errors.push(`'hydration.derive_from' stands alone: a derived entity ` +
          `has no table of its own, so ${others.join(', ')} cannot apply`);
    }
  }
  return errors;
}

/** Validates an entity's `mode` as written; undefined when it is valid. */
export function modeDocError(mode: unknown): string|undefined {
  return (BINDING_MODES as readonly unknown[]).includes(mode) ?
      undefined :
      `'mode' must be ${BINDING_MODES.map(m => `'${m}'`).join(' or ')}`;
}

/**
 * Maps a validated document `hydration` block (snake_case) onto the IR.
 * Absent rules stay absent.
 */
export function hydrationFromDoc(doc: any): EntityHydration {
  const out: EntityHydration = {};
  if (doc.grain !== undefined) {
    out.grain = doc.grain.latest_by !== undefined ?
        {latestBy: doc.grain.latest_by} :
        {deterministic: true};
  }
  if (doc.normalize !== undefined) {
    out.normalize = doc.normalize.map((r: any): NormalizeRule => {
      const rule: NormalizeRule = {field: r.field};
      if (r.before !== undefined) rule.before = dateBound(r.before);
      if (r.after !== undefined) rule.after = dateBound(r.after);
      if (r.divide_by !== undefined) rule.divideBy = r.divide_by;
      if (r.multiply_by !== undefined) rule.multiplyBy = r.multiply_by;
      if (r.on !== undefined) rule.on = r.on;
      return rule;
    });
  }
  if (doc.resolve !== undefined) {
    out.resolve = doc.resolve.map(
        (r: any): ResolveRule => ({field: r.field, match: [...r.match]}));
  }
  if (doc.derive_from !== undefined) {
    out.deriveFrom = {relationship: doc.derive_from.relationship};
  }
  return out;
}

/** The inverse of hydrationFromDoc: the IR back to the document form. */
export function hydrationToDoc(h: EntityHydration): Record<string, any> {
  const out: Record<string, any> = {};
  if (h.grain) {
    out.grain = h.grain.latestBy !== undefined ? {latest_by: h.grain.latestBy} :
                                                 {deterministic: true};
  }
  if (h.normalize?.length) {
    out.normalize = h.normalize.map(r => {
      const o: Record<string, any> = {field: r.field};
      if (r.before !== undefined) o.before = r.before;
      if (r.after !== undefined) o.after = r.after;
      if (r.divideBy !== undefined) o.divide_by = r.divideBy;
      if (r.multiplyBy !== undefined) o.multiply_by = r.multiplyBy;
      if (r.on !== undefined) o.on = r.on;
      return o;
    });
  }
  if (h.resolve?.length) {
    out.resolve = h.resolve.map(r => ({field: r.field, match: [...r.match]}));
  }
  if (h.deriveFrom) out.derive_from = {relationship: h.deriveFrom.relationship};
  return out;
}

/** Whether the entity is bound directly (no node view). */
export function isDirect(entity: Pick<Entity, 'mode'>): boolean {
  return entity.mode === 'direct';
}

/** Whether the entity's rows are derived from a relationship. */
export function isDerivedEntity(entity: Pick<Entity, 'hydration'>): boolean {
  return entity.hydration?.deriveFrom !== undefined;
}

/** Whether an entity's source is absent (or the OWL importer's placeholder). */
export function hasNoSource(entity: Pick<Entity, 'dataSource'>): boolean {
  const s = (entity.dataSource ?? '').trim();
  return !s || s.startsWith('unbound:');
}

// ---------------------------------------------------------------------------
// Cross-reference checks.
// ---------------------------------------------------------------------------

/**
 * The relationship a resolve rule's field is the foreign key of: a plain
 * (non-abstract, non-derived, non-junction) relationship from `entity` (or
 * one of its supertypes) joining on exactly that one field.
 */
export function resolveRelationship(
    model: SemanticModel, entity: Entity, field: string): Relationship|undefined {
  const owners = new Set([entity.name, ...ancestorsOf(model, entity.name)]);
  return (model.relationships ?? [])
      .find(
          r => owners.has(r.source.entity) && !r.abstract && !r.via?.length &&
              !r.association && r.source.columns.length === 1 &&
              r.source.columns[0] === field);
}

function ancestorsOf(model: SemanticModel, name: string): string[] {
  const byName = new Map((model.entities ?? []).map(e => [e.name, e]));
  const out: string[] = [];
  const queue = [...(byName.get(name)?.extends ?? [])];
  while (queue.length) {
    const next = queue.shift()!;
    if (out.includes(next) || next === name) continue;
    out.push(next);
    queue.push(...(byName.get(next)?.extends ?? []));
  }
  return out;
}

/**
 * Whether `field` of `dest` may be matched by a resolve rule: the
 * destination's (single-field) key, a single-field unique key, or -- for a
 * vocabulary -- a field that reads a member's label.
 */
export function isMatchableField(dest: Entity, field: string): boolean {
  if (dest.keys.length === 1 && dest.keys[0] === field) return true;
  if ((dest.uniqueKeys ?? []).some(u => u.length === 1 && u[0] === field)) {
    return true;
  }
  if (dest.members !== undefined) {
    const f = dest.fields.find(x => x.name === field);
    const col = f?.expression ?? (f ? snakeCase(f.name) : undefined);
    return col === 'label';
  }
  return false;
}

/**
 * Checks every entity's hydration against the model. `errors` are what a
 * push rejects; there are no advisory findings today. With `fieldsPruned` (a
 * profile dropped unbound fields, and with them anything that read them) a
 * reference to a missing field or relationship stands down -- the lowering
 * skips that rule -- as other field checks do.
 */
export function checkHydration(
    model: SemanticModel,
    opts: {fieldsPruned?: boolean} = {}): {errors: string[]; warnings: string[]} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const entities = model.entities ?? [];
  if (!entities.some(e => e.hydration || e.mode)) return {errors, warnings};

  let fieldsOf: (name: string) => Map<string, Field>;
  try {
    const concepts = declaredConceptFields(model);
    fieldsOf = name => concepts.get(name)?.fields ?? new Map();
  } catch {
    const byName = new Map(entities.map(e => [e.name, e]));
    fieldsOf = name =>
        new Map((byName.get(name)?.fields ?? []).map(f => [f.name, f]));
  }
  const byName = new Map(entities.map(e => [e.name, e]));
  const relByName = new Map((model.relationships ?? []).map(r => [r.name, r]));
  const pruned = !!opts.fieldsPruned;

  for (const e of entities) {
    const h = e.hydration;
    const at = `entity '${e.name}'`;
    if (!h) continue;
    const kind = e.abstract ? 'an abstract' :
        e.definition       ? 'a defined' :
        e.members !== undefined ? 'a vocabulary' :
                                  undefined;
    if (kind) {
      errors.push(`${at}: 'hydration' applies to an entity read from a ` +
          `table, and this is ${kind} entity; remove 'hydration'`);
      continue;
    }
    if (isDirect(e)) {
      const viewOnly = (['grain', 'normalize', 'deriveFrom'] as const)
                           .filter(r => h[r] !== undefined);
      if (viewOnly.length) {
        errors.push(`${at}: 'mode: direct' binds the source table as-is, so ` +
            `hydration ${viewOnly.map(r => r === 'deriveFrom' ? 'derive_from' : r)
                .join(', ')} has no node view to apply in; use 'mode: view' ` +
            `or remove the rule (resolve alone is applied in the edge view)`);
      }
    }
    const fields = fieldsOf(e.name);
    const keySet = new Set(e.keys);

    // grain.latest_by names a physical column of the source, which only the
    // store can confirm: BigQuery rejects the node view when it is missing.
    for (const r of h.normalize ?? []) {
      if (!fields.has(r.field)) {
        if (!pruned) {
          errors.push(`${at}: hydration.normalize names '${r.field}', which ` +
              `is not a field of the entity`);
        }
        continue;
      }
      if (keySet.has(r.field)) {
        errors.push(`${at}: hydration.normalize cannot change key field ` +
            `'${r.field}' (a key identifies the row)`);
      }
      if (r.on === undefined && h.grain?.latestBy === undefined) {
        errors.push(`${at}: hydration.normalize on '${r.field}' needs 'on' ` +
            `(the date column compared), or a grain.latest_by to default to`);
      }
    }
    const resolvedFields = new Set<string>();
    for (const r of h.resolve ?? []) {
      if (resolvedFields.has(r.field)) {
        errors.push(`${at}: hydration.resolve names '${r.field}' twice`);
      }
      resolvedFields.add(r.field);
      if (!fields.has(r.field)) {
        if (!pruned) {
          errors.push(`${at}: hydration.resolve names '${r.field}', which is ` +
              `not a field of the entity`);
        }
        continue;
      }
      const rel = resolveRelationship(model, e, r.field);
      if (!rel) {
        if (!pruned) {
          errors.push(`${at}: hydration.resolve field '${r.field}' is not the ` +
              `foreign key of a relationship from '${e.name}' (resolve names ` +
              `the single from_columns field of a relationship)`);
        }
        continue;
      }
      const dest = byName.get(rel.destination.entity);
      if (!dest) continue;
      if (dest.keys.length !== 1 || rel.destination.columns[0] !== dest.keys[0]) {
        errors.push(`${at}: hydration.resolve field '${r.field}' joins ` +
            `relationship '${rel.name}' to '${
                rel.destination.columns.join(', ')}', which is not ` +
            `'${dest.name}''s single-field key; resolve rewrites the value to ` +
            `the destination's key`);
        continue;
      }
      const destFields = fieldsOf(dest.name);
      for (const m of r.match) {
        if (!destFields.has(m)) {
          errors.push(`${at}: hydration.resolve match '${m}' is not a field ` +
              `of '${dest.name}'`);
        } else if (!isMatchableField(dest, m)) {
          errors.push(`${at}: hydration.resolve match '${m}' is neither ` +
              `'${dest.name}''s key nor one of its single-field unique_keys; ` +
              `a value matched against a non-unique field would be ambiguous ` +
              `(declare it in unique_keys if it is unique)`);
        }
      }
    }
    if (h.deriveFrom) {
      const rel = relByName.get(h.deriveFrom.relationship);
      if (!hasNoSource(e)) {
        errors.push(`${at}: hydration.derive_from derives the entity's rows ` +
            `from relationship '${h.deriveFrom.relationship}', so the ` +
            `entity has no table; remove 'source' or remove derive_from`);
      }
      if (!rel) {
        if (!pruned) {
          errors.push(`${at}: hydration.derive_from names relationship '${
              h.deriveFrom.relationship}', which is not in the model`);
        }
      } else if (
          rel.destination.entity !== e.name || e.keys.length !== 1 ||
          rel.destination.columns.length !== 1 ||
          rel.destination.columns[0] !== e.keys[0] ||
          rel.source.columns.length !== 1 || rel.via?.length ||
          rel.association || rel.abstract) {
        errors.push(`${at}: hydration.derive_from relationship '${
            rel.name}' must be a plain foreign key whose destination is ` +
            `'${e.name}''s single-field key (to: ${e.name}, to_columns: [${
                e.keys.join(', ')}]) with one from_columns field`);
      } else if (rel.source.entity === e.name) {
        errors.push(`${at}: hydration.derive_from relationship '${
            rel.name}' starts at '${e.name}' itself; a derived entity is ` +
            `read from another entity`);
      }
    }
  }
  return {errors, warnings};
}

// ---------------------------------------------------------------------------
// The human summary (node-view descriptions, catalog entries).
// ---------------------------------------------------------------------------

function formatNumber(n: number): string {
  return String(n);
}

/**
 * One clause per rule, in a fixed order, e.g.
 *   latest version per opportunity_id by created_at
 *   one row per buyer_id (deterministic pick)
 *   wonAmount ÷100 before 2024-03-25
 *   homeMarketUnit resolved to MarketUnit by marketUnitCode or unitName
 *   derived from allianceWith
 *   bound directly (no node view)
 * The wording is fixed so the catalog trailer can be parsed back (see
 * hydration_kc.ts). Key columns are the node view's (snake_case of the key
 * fields).
 */
export function hydrationClauses(
    entity: Pick<Entity, 'keys'|'hydration'|'mode'>,
    destinationOf: (field: string) => string | undefined = () => undefined):
    string[] {
  const h = entity.hydration;
  const out: string[] = [];
  const keyCols = (entity.keys ?? []).map(snakeCase).join(', ') || 'key';
  if (h?.grain?.latestBy !== undefined) {
    out.push(`latest version per ${keyCols} by ${h.grain.latestBy}`);
  } else if (h?.grain?.deterministic) {
    out.push(`one row per ${keyCols} (deterministic pick)`);
  }
  for (const r of h?.normalize ?? []) {
    const op = r.divideBy !== undefined ? `÷${formatNumber(r.divideBy)}` :
                                          `×${formatNumber(r.multiplyBy ?? 1)}`;
    const when = r.before !== undefined ? `before ${r.before}` :
                                          `from ${r.after}`;
    out.push(`${r.field} ${op} ${when}${r.on !== undefined ? ` by ${r.on}` : ''}`);
  }
  for (const r of h?.resolve ?? []) {
    const dest = destinationOf(r.field);
    out.push(`${r.field} resolved${dest ? ` to ${dest}` : ''} by ${
        r.match.join(' or ')}`);
  }
  if (h?.deriveFrom) out.push(`derived from ${h.deriveFrom.relationship}`);
  if (entity.mode === 'direct') out.push('bound directly (no node view)');
  return out;
}
