// Units, grain and history (K7): the per-field `unit` / `scale` and the
// per-entity `grain` / `history` metadata (see ir.Field.unit/scale and
// ir.Entity.grain/history).
//
// None of the four changes what a graph or a catalog entry IS -- a node table
// stays the table it was, a property the column it was -- they say how to READ
// it: what a value measures, what one row stands for, and which rows are the
// current ones. So every target that has no dedicated slot carries them the
// way K1 carries a definition (knowledge_catalog.entityDescription): as fixed,
// parseable trailing paragraphs on the element's description.
//
//   field:   <description>\n\nUnit: USD (x1000).
//            <description>\n\nUnit: USD.
//            <description>\n\nScale: x1000.
//   entity:  <description + K1 trailers>\n\nGrain: one row per opportunity version
//            \n\nHistory: versioned; current rows where is_current; valid from
//            valid_from; valid to valid_to.
//
// The Knowledge Catalog pull (kc_converter) peels the same paragraphs back off
// (splitUnitTrailer / splitGrainHistoryTrailers), so a push -> pull
// round-trips the spec keys. Everything K7 owns lives in this module -- the
// trailer codec, the static checks, and the skill-page wording -- so the
// feature is easy to find, rename or drop.

import {DataType, Entity, EntityHistory, Field, SemanticModel} from './ir';
import {declaredConceptFields} from './resolve_inheritance';

export const UNIT_PREFIX = 'Unit: ';
export const SCALE_PREFIX = 'Scale: ';
export const GRAIN_PREFIX = 'Grain: ';
export const HISTORY_PREFIX = 'History: ';

// Folds line breaks (and the indentation around them) to one space, so a
// trailer stays one paragraph and the blank-line split on pull cannot cut it.
function oneLine(text: string): string {
  return text.trim().replace(/\s*\n\s*/g, ' ');
}

function joinParagraphs(parts: (string|undefined)[]): string|undefined {
  const kept = parts.filter((p): p is string => !!p && p.trim() !== '');
  return kept.length ? kept.join('\n\n') : undefined;
}

// ---------------------------------------------------------------------------
// Field: unit / scale.
// ---------------------------------------------------------------------------

/** `x1000` for a scale of 1000. */
export function scaleText(scale: number): string {
  return `x${String(scale)}`;
}

/**
 * The field trailer: `Unit: USD (x1000).`, `Unit: USD.`, `Scale: x1000.`, or
 * undefined when the field declares neither.
 */
export function unitTrailer(field: Pick<Field, 'unit'|'scale'>): string|
    undefined {
  const unit = field.unit?.trim() ? oneLine(field.unit) : undefined;
  const scale = field.scale !== undefined ? scaleText(field.scale) : undefined;
  if (unit !== undefined && scale !== undefined) {
    return `${UNIT_PREFIX}${unit} (${scale}).`;
  }
  if (unit !== undefined) return `${UNIT_PREFIX}${unit}.`;
  if (scale !== undefined) return `${SCALE_PREFIX}${scale}.`;
  return undefined;
}

/** A field description with its unit trailer appended (see unitTrailer). */
export function withUnitTrailer(
    description: string|undefined,
    field: Pick<Field, 'unit'|'scale'>): string|undefined {
  const trailer = unitTrailer(field);
  if (trailer === undefined) return description;
  return joinParagraphs([description, trailer]);
}

function parseScale(text: string): number|undefined {
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Peels a unit trailer (the final paragraph, see unitTrailer) off a pulled
 * field description. A description without one comes back untouched.
 */
export function splitUnitTrailer(text: string|undefined):
    {rest: string|undefined; unit?: string; scale?: number} {
  if (text === undefined) return {rest: undefined};
  const paragraphs = text.split('\n\n');
  const last = paragraphs[paragraphs.length - 1];
  let unit: string|undefined;
  let scale: number|undefined;
  const withScale = /^Unit: (.+) \(x([^()\s]+)\)\.$/.exec(last);
  const unitOnly = /^Unit: (.+)\.$/.exec(last);
  const scaleOnly = /^Scale: x([^()\s]+)\.$/.exec(last);
  if (withScale && parseScale(withScale[2]) !== undefined) {
    unit = withScale[1];
    scale = parseScale(withScale[2]);
  } else if (scaleOnly && parseScale(scaleOnly[1]) !== undefined) {
    scale = parseScale(scaleOnly[1]);
  } else if (unitOnly) {
    unit = unitOnly[1];
  } else {
    return {rest: text};
  }
  const rest = paragraphs.slice(0, -1).join('\n\n');
  const out: {rest: string|undefined; unit?: string; scale?: number} = {
    rest: rest === '' ? undefined : rest,
  };
  if (unit !== undefined) out.unit = unit;
  if (scale !== undefined) out.scale = scale;
  return out;
}

// ---------------------------------------------------------------------------
// Entity: grain / history.
// ---------------------------------------------------------------------------

/** `Grain: <text>`, verbatim (no period added), or undefined. */
export function grainTrailer(entity: Pick<Entity, 'grain'>): string|undefined {
  return entity.grain?.trim() ? `${GRAIN_PREFIX}${oneLine(entity.grain)}` :
                                undefined;
}

/**
 * `History: versioned; current rows where is_current; valid from vf; valid to
 * vt.` -- each clause only when declared -- or undefined.
 */
export function historyTrailer(entity: Pick<Entity, 'history'>): string|
    undefined {
  const h = entity.history;
  if (!h) return undefined;
  const parts = [h.versioned ? 'versioned' : 'not versioned'];
  if (h.currentFlag) parts.push(`current rows where ${h.currentFlag}`);
  if (h.validFrom) parts.push(`valid from ${h.validFrom}`);
  if (h.validTo) parts.push(`valid to ${h.validTo}`);
  return `${HISTORY_PREFIX}${parts.join('; ')}.`;
}

/** The entity trailers, in publish order (Grain, then History). */
export function entityTrailers(entity: Pick<Entity, 'grain'|'history'>):
    string[] {
  return [grainTrailer(entity), historyTrailer(entity)].filter(
      (p): p is string => p !== undefined);
}

/** An entity description with its K7 trailers appended. */
export function withEntityTrailers(
    description: string|undefined,
    entity: Pick<Entity, 'grain'|'history'>): string|undefined {
  const trailers = entityTrailers(entity);
  if (!trailers.length) return description;
  return joinParagraphs([description, ...trailers]);
}

function parseHistory(paragraph: string): EntityHistory|undefined {
  if (!paragraph.startsWith(HISTORY_PREFIX) || !paragraph.endsWith('.')) {
    return undefined;
  }
  const parts = paragraph.slice(HISTORY_PREFIX.length, -1).split('; ');
  let versioned: boolean;
  if (parts[0] === 'versioned') {
    versioned = true;
  } else if (parts[0] === 'not versioned') {
    versioned = false;
  } else {
    return undefined;
  }
  const h: EntityHistory = {versioned};
  for (const part of parts.slice(1)) {
    const m = /^(current rows where|valid from|valid to) (\S+)$/.exec(part);
    if (!m) return undefined;
    if (m[1] === 'current rows where') h.currentFlag = m[2];
    if (m[1] === 'valid from') h.validFrom = m[2];
    if (m[1] === 'valid to') h.validTo = m[2];
  }
  return h;
}

/**
 * Peels the History then the Grain paragraph (see entityTrailers) off the end
 * of a pulled entity description, returning them and the remaining text for
 * the K1 / inheritance trailer splitters. Absent trailers leave the text
 * untouched.
 */
export function splitGrainHistoryTrailers(text: string|undefined):
    {rest: string|undefined; grain?: string; history?: EntityHistory} {
  if (text === undefined) return {rest: undefined};
  let paragraphs = text.split('\n\n');
  const out: {rest: string|undefined; grain?: string; history?: EntityHistory} =
      {rest: text};
  const history = parseHistory(paragraphs[paragraphs.length - 1]);
  if (history) {
    out.history = history;
    paragraphs = paragraphs.slice(0, -1);
  }
  const last = paragraphs[paragraphs.length - 1];
  if (last !== undefined && last.startsWith(GRAIN_PREFIX)) {
    const grain = last.slice(GRAIN_PREFIX.length).trim();
    if (grain) {
      out.grain = grain;
      paragraphs = paragraphs.slice(0, -1);
    }
  }
  if (out.grain === undefined && out.history === undefined) return out;
  const rest = paragraphs.join('\n\n');
  out.rest = rest === '' ? undefined : rest;
  return out;
}

// ---------------------------------------------------------------------------
// Static checks.
// ---------------------------------------------------------------------------

const TEMPORAL: ReadonlySet<DataType> =
    new Set<DataType>(['Date', 'Time', 'DateTime', 'DateTimeTz']);

/**
 * Checks the K7 metadata of a model. `errors` are what a push rejects: a
 * non-positive scale (a hand-built IR; the loader already rejects one in a
 * document), and a history key naming a field the entity does not have
 * (inherited fields count). `warnings` are advisory: a `current_flag` whose
 * type is known and is not Boolean, a `valid_from` / `valid_to` whose type is
 * known and is not temporal. With `fieldsPruned` (a binding profile dropped
 * unbound fields) the missing-field check stands down, as constraint checks do.
 */
export function checkUnitsAndHistory(
    model: SemanticModel,
    opts: {fieldsPruned?: boolean} = {}): {errors: string[]; warnings: string[]} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const entities = model.entities ?? [];

  const checkScale = (owner: string, f: Field) => {
    if (f.scale === undefined) return;
    if (!(typeof f.scale === 'number' && Number.isFinite(f.scale) &&
          f.scale > 0)) {
      errors.push(`field '${owner}.${f.name}': scale must be a number > 0 ` +
          `(got ${String(f.scale)})`);
    }
  };
  for (const e of entities) {
    for (const f of e.fields ?? []) checkScale(e.name, f);
  }
  for (const r of model.relationships ?? []) {
    for (const f of r.association?.fields ?? []) checkScale(r.name, f);
  }

  if (!entities.some(e => e.history)) return {errors, warnings};
  // Inherited fields count: `current_flag` may live on a supertype. Resolving
  // throws on a dangling `extends` (validate reports that once, elsewhere), so
  // fall back to each entity's own fields.
  let fieldsOf: (name: string) => Map<string, Field>;
  try {
    const concepts = declaredConceptFields(model);
    fieldsOf = name => concepts.get(name)?.fields ?? new Map();
  } catch {
    const byName = new Map(entities.map(e => [e.name, e]));
    fieldsOf = name =>
        new Map((byName.get(name)?.fields ?? []).map(f => [f.name, f]));
  }
  for (const e of entities) {
    const h = e.history;
    if (!h) continue;
    const fields = fieldsOf(e.name);
    const refs: Array<[string, string|undefined]> = [
      ['current_flag', h.currentFlag],
      ['valid_from', h.validFrom],
      ['valid_to', h.validTo],
    ];
    for (const [key, name] of refs) {
      if (name === undefined) continue;
      const f = fields.get(name);
      if (!f) {
        if (!opts.fieldsPruned) {
          errors.push(`entity '${e.name}': history.${key} names '${name}', ` +
              `which is not a field of the entity`);
        }
        continue;
      }
      if (key === 'current_flag' && f.type !== undefined &&
          f.type !== 'Boolean' && f.type !== 'Opaque') {
        warnings.push(`entity '${e.name}': history.current_flag '${name}' is ` +
            `${f.type}, not Boolean; the skill tells agents to filter on ` +
            `'${name} = TRUE'`);
      }
      if (key !== 'current_flag' && f.type !== undefined &&
          f.type !== 'Opaque' && !TEMPORAL.has(f.type)) {
        warnings.push(`entity '${e.name}': history.${key} '${name}' is ` +
            `${f.type}, not a date/time type`);
      }
    }
  }
  return {errors, warnings};
}

// ---------------------------------------------------------------------------
// Skill-page wording (skills_query entity pages).
// ---------------------------------------------------------------------------

/**
 * The Notes text for a property's unit/scale, e.g. `Unit: USD. Scale: x1000
 * (a stored 1 is 1000 USD).`, or undefined.
 */
export function unitNote(field: Pick<Field, 'unit'|'scale'>): string|
    undefined {
  const unit = field.unit?.trim() ? oneLine(field.unit) : undefined;
  const parts: string[] = [];
  if (unit !== undefined) parts.push(`Unit: ${unit}.`);
  if (field.scale !== undefined) {
    parts.push(`Scale: ${scaleText(field.scale)} (a stored 1 is ${
        String(field.scale)}${unit !== undefined ? ` ${unit}` : ''}).`);
  }
  return parts.length ? parts.join(' ') : undefined;
}

/**
 * The grain and history lines of an entity page. `column` maps a field name
 * to its physical column (for the SQL form of the current-row filter).
 */
export function grainHistoryLines(
    entity: Pick<Entity, 'grain'|'history'>,
    column: (field: string) => string): string[] {
  const out: string[] = [];
  if (entity.grain?.trim()) {
    const grain = oneLine(entity.grain);
    out.push(`Grain: ${grain}${/[.!?]$/.test(grain) ? '' : '.'}`);
  }
  const h = entity.history;
  if (!h) return out;
  if (!h.versioned) {
    out.push('History: not versioned; each row is the current state.');
    return out;
  }
  const span = h.validFrom || h.validTo ?
      ` Each version is valid${h.validFrom ? ` from \`${h.validFrom}\`` : ''}${
          h.validTo ? ` to \`${h.validTo}\`` : ''}.` :
      '';
  if (h.currentFlag) {
    out.push(
        `History: versioned. This node table holds every version of each ` +
        `record, not only the current one.${span} For current rows filter ` +
        `on \`${h.currentFlag}\`: \`WHERE n.${h.currentFlag} = TRUE\` in GQL, ` +
        `\`WHERE ${column(h.currentFlag)} = TRUE\` in SQL. Counts, totals ` +
        `and "current" questions need that filter; questions about changes ` +
        `over time do not.`);
  } else {
    out.push(
        `History: versioned. This node table holds every version of each ` +
        `record.${span} No current-row flag is declared: pick the version ` +
        `in force per key (e.g. the latest${
            h.validFrom ? ` \`${h.validFrom}\`` : ''}) before counting or ` +
        `summing.`);
  }
  return out;
}
