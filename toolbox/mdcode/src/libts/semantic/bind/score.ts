// `kcmd bind`, steps 1 and 2: which table backs each entity, and which column
// each field reads (pure functions; see docs/semantic-model/bind.md).
//
// For each CONCRETE entity (keyed; not abstract, defined or a vocabulary)
// every scanned table is scored:
//
//   0.35  name similarity: the entity's name and synonyms against the table's
//         name (token Jaccard and edit distance, averaged)
//   0.30  key present: every key field matched to a column (1); a key only
//         guessed from the table's first `_id` column counts half
//   0.25  field coverage: the share of the entity's fields (inherited ones
//         included) matched to a type-compatible column; a type mismatch or a
//         guessed key counts half
//   0.10  a Knowledge Catalog search for the entity's names returned the table
//
// Tables are then assigned greedily, best score first, one table per entity
// and one entity per table. The assigned table is AUTO-ACCEPTED when it holds
// the key, its coverage is >= 0.6 and it beats the entity's runner-up by
// >= 0.15; otherwise the entity NEEDS REVIEW with its top candidates listed.
//
// Deprecated-class guard: a table that looks more like a deprecated entity
// (by name) than like an authoritative one is a SHADOW of the deprecated
// entity for the authoritative one -- a frozen copy with the same columns --
// and is neither assigned to it nor counted as its runner-up.
//
// A keyed entity left without a table whose key is the destination of a plain
// relationship from a bound entity is DERIVED from that relationship (its rows
// are the distinct foreign-key values). A vocabulary binds to its generated
// view (no source); only fields whose names differ from the view's columns
// need an expression.

import {snakeCase} from '../generated_views';
import {DataType, Entity, Field, Relationship, SemanticModel} from '../ir';
import {resolveInheritance} from '../resolve_inheritance';
import {ScanColumn, ScanTable, tableRef} from './scan';

export const WEIGHTS = {name: 0.35, key: 0.30, coverage: 0.25, kc: 0.10};

export interface BindThresholds {
  // Minimum field coverage of an auto-accepted table.
  coverage: number;
  // Minimum score margin over the runner-up of an auto-accepted table.
  margin: number;
  // Candidates scoring below this are not listed.
  minCandidate: number;
}

export const DEFAULT_THRESHOLDS: BindThresholds = {
  coverage: 0.6,
  margin: 0.15,
  minCandidate: 0.2,
};

// ---------------------------------------------------------------------------
// Names.
// ---------------------------------------------------------------------------

/** snake_case words of a name, label or table name, as written. */
export function words(s: string): string[] {
  return snakeCase(String(s ?? '').replace(/[^A-Za-z0-9]+/g, '_'))
      .split('_')
      .filter(Boolean);
}

/** snake_case form of a name or label (`lead originator ID` -> `lead_originator_id`). */
export function snakeName(s: string): string {
  return words(s).join('_');
}

/** A light plural stem: `opportunities` -> `opportunity`, `deals` -> `deal`. */
export function stem(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

/** Stemmed words. */
export function tokens(s: string): string[] {
  return words(s).map(stem);
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({length: b.length + 1}, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1,
                        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function round(n: number, digits = 3): number {
  return Number(n.toFixed(digits));
}

/**
 * How alike two names are, 0..1: the average of the token Jaccard index and
 * the normalized edit distance of the compacted forms (1 when the compacted
 * forms are equal, so `QAHealthCheck` and `qa_healthcheck` are the same name).
 */
export function nameSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  const ca = ta.join('');
  const cb = tb.join('');
  if (!ca || !cb) return 0;
  if (ca === cb) return 1;
  const sa = new Set(ta);
  const sb = new Set(tb);
  const inter = [...sa].filter(t => sb.has(t)).length;
  const jaccard = inter / new Set([...sa, ...sb]).size;
  const edit = 1 - levenshtein(ca, cb) / Math.max(ca.length, cb.length);
  return round(0.5 * jaccard + 0.5 * edit);
}

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------

type TypeGroup = 'string'|'number'|'date'|'time'|'boolean'|'other';

function bqGroup(type: string): TypeGroup {
  const t = type.trim().toUpperCase();
  if (t === 'STRING') return 'string';
  if (/^(INT64|INTEGER|NUMERIC|BIGNUMERIC|DECIMAL|BIGDECIMAL|FLOAT64|FLOAT)\b/.test(t)) {
    return 'number';
  }
  if (t === 'DATE' || t === 'DATETIME' || t === 'TIMESTAMP') return 'date';
  if (t === 'TIME') return 'time';
  if (t === 'BOOL' || t === 'BOOLEAN') return 'boolean';
  return 'other';
}

function modelGroup(type: DataType): TypeGroup|undefined {
  switch (type) {
    case 'String':
      return 'string';
    case 'Integer':
    case 'Decimal':
    case 'Float':
      return 'number';
    case 'Date':
    case 'DateTime':
    case 'DateTimeTz':
      return 'date';
    case 'Time':
      return 'time';
    case 'Boolean':
      return 'boolean';
    default:
      return undefined;
  }
}

/** Whether a column of BigQuery type `bqType` can hold a field of `type`. */
export function typeCompatible(type: DataType|undefined, bqType: string): boolean {
  const want = type === undefined ? undefined : modelGroup(type);
  if (want === undefined) return true;
  return bqGroup(bqType) === want;
}

/** Whether a BigQuery column type is a date or timestamp. */
export function isDateColumn(c: Pick<ScanColumn, 'type'>): boolean {
  return bqGroup(c.type) === 'date';
}

// ---------------------------------------------------------------------------
// Entities.
// ---------------------------------------------------------------------------

export type EntityKind = 'concrete'|'abstract'|'defined'|'vocabulary'|'keyless';

export function entityKind(e: Entity): EntityKind {
  if (e.abstract) return 'abstract';
  if (e.definition) return 'defined';
  if (e.members !== undefined) return 'vocabulary';
  if (!(e.keys ?? []).length) return 'keyless';
  return 'concrete';
}

/**
 * Whether the entity is deprecated (the OWL importer writes owl:deprecated as
 * a description starting `DEPRECATED:` and an instruction `X is deprecated`),
 * and the entity it points to instead (`use Opportunity`).
 */
export function deprecation(e: Entity): {use?: string}|undefined {
  const text = [e.description ?? '', ...(e.aiContext?.instructions ? [e.aiContext.instructions] : [])]
                   .join('\n');
  const flagged = /^\s*DEPRECATED\b/i.test(e.description ?? '') ||
      /\bis deprecated\b/i.test(e.aiContext?.instructions ?? '');
  if (!flagged) return undefined;
  const m = text.match(/\b[Uu]se (?:the )?([A-Z][A-Za-z0-9_]*)/);
  return m ? {use: m[1]} : {};
}

/** The entity with the fields it inherits, as bind matches them. */
interface EntityInfo {
  entity: Entity;
  fields: Field[];
  keys: string[];
  // The names the entity goes by: its name, then its synonyms.
  names: string[];
  // Stemmed tokens of those names (for stripping `account` off
  // `accountCreatedAt`).
  nameTokens: Set<string>;
}

function entityInfo(entity: Entity, flattened: Entity|undefined): EntityInfo {
  const fields = flattened?.fields ?? entity.fields ?? [];
  const names = [entity.name, ...(entity.aiContext?.synonyms ?? [])];
  return {
    entity,
    fields,
    keys: entity.keys ?? [],
    names,
    nameTokens: new Set(names.flatMap(tokens)),
  };
}

// ---------------------------------------------------------------------------
// Field -> column.
// ---------------------------------------------------------------------------

export interface FieldMatch {
  field: string;
  column: string;
  // 0..1: how sure the match is (halved on a type mismatch).
  strength: number;
  // Which rule matched (`name`, `label`, `code suffix`, ...).
  rule: string;
  typeOk: boolean;
  // A key bound to the table's first `_id` column for want of a match.
  guessed?: boolean;
}

interface Proposal {
  column: ScanColumn;
  strength: number;
  rule: string;
}

const ROLE_WORDS = new Set(['name', 'email', 'title']);

function fieldProposals(field: Field, columns: ScanColumn[], info: EntityInfo): Proposal[] {
  const byName = new Map(columns.map(c => [c.name.toLowerCase(), c]));
  const best = new Map<string, Proposal>();
  const add = (name: string, strength: number, rule: string) => {
    const column = byName.get(name.toLowerCase());
    if (!column) return;
    const prev = best.get(column.name);
    if (!prev || prev.strength < strength) best.set(column.name, {column, strength, rule});
  };
  const sn = snakeName(field.name);
  add(sn, 1, 'name');
  if (field.label) add(snakeName(field.label), 0.95, 'label');
  for (const suffix of ['_code', '_key']) {
    if (sn.endsWith(suffix) && sn.length > suffix.length) {
      add(sn.slice(0, -suffix.length), 0.9, `${suffix.slice(1)} suffix`);
    }
  }
  const ws = sn.split('_');
  for (let i = 1; i < ws.length && info.nameTokens.has(stem(ws[i - 1])); i++) {
    add(ws.slice(i).join('_'), 0.85, 'entity prefix');
  }
  const endings = columns.filter(c => c.name.toLowerCase().endsWith(`_${sn}`));
  if (endings.length === 1) add(endings[0].name, 0.8, 'suffix');
  for (const syn of field.aiContext?.synonyms ?? []) add(snakeName(syn), 0.8, 'synonym');
  const role = ws[ws.length - 1];
  if (ROLE_WORDS.has(role)) {
    const same = columns.filter(c => c.name.toLowerCase().split('_').pop() === role);
    if (same.length === 1) add(same[0].name, 0.6, `only ${role} column`);
  }
  return [...best.values()];
}

/**
 * Matches the entity's fields to the table's columns: every rule's proposals,
 * assigned greedily (key fields first, then by strength), one column per
 * field. A single key left unmatched is guessed from the first `_id` column.
 */
export function matchFields(info: EntityInfo, columns: ScanColumn[]):
    {matches: FieldMatch[]; unmatched: string[]} {
  const keySet = new Set(info.keys);
  const triples: Array<{field: Field; index: number; p: Proposal; typeOk: boolean; strength: number}> = [];
  info.fields.forEach((field, index) => {
    for (const p of fieldProposals(field, columns, info)) {
      const typeOk = typeCompatible(field.type, p.column.type);
      triples.push({field, index, p, typeOk, strength: typeOk ? p.strength : p.strength / 2});
    }
  });
  triples.sort((a, b) => Number(keySet.has(b.field.name)) - Number(keySet.has(a.field.name)) ||
                   b.strength - a.strength || a.index - b.index ||
                   a.p.column.ordinal - b.p.column.ordinal);
  const byField = new Map<string, FieldMatch>();
  const used = new Set<string>();
  for (const t of triples) {
    if (byField.has(t.field.name) || used.has(t.p.column.name)) continue;
    byField.set(t.field.name, {
      field: t.field.name,
      column: t.p.column.name,
      strength: round(t.strength),
      rule: t.p.rule,
      typeOk: t.typeOk,
    });
    used.add(t.p.column.name);
  }
  if (info.keys.length === 1 && !byField.has(info.keys[0])) {
    const key = info.fields.find(f => f.name === info.keys[0]);
    const guess = [...columns]
                      .sort((a, b) => a.ordinal - b.ordinal)
                      .find(c => !used.has(c.name) && /_id$/i.test(c.name));
    if (guess) {
      byField.set(info.keys[0], {
        field: info.keys[0],
        column: guess.name,
        strength: 0.3,
        rule: 'first _id column',
        typeOk: typeCompatible(key?.type, guess.type),
        guessed: true,
      });
    }
  }
  const matches = info.fields.map(f => byField.get(f.name))
                      .filter((m): m is FieldMatch => !!m);
  const unmatched = info.fields.map(f => f.name).filter(n => !byField.has(n));
  return {matches, unmatched};
}

// ---------------------------------------------------------------------------
// Entity -> table.
// ---------------------------------------------------------------------------

export interface Candidate {
  table: string;  // project.dataset.table
  score: number;
  nameSim: number;
  keyPresent: boolean;
  keyGuessed: boolean;
  coverage: number;
  kcHit: boolean;
  matches: FieldMatch[];
  unmatched: string[];
  // The deprecated entity this table looks more like (see the guard).
  shadowOf?: string;
  // The entity the table was assigned to instead.
  takenBy?: string;
}

export function scoreCandidate(
    info: EntityInfo, table: ScanTable, kcHit = false): Candidate {
  const nameSim = Math.max(0, ...info.names.map(n => nameSimilarity(n, table.table)));
  const {matches, unmatched} = matchFields(info, table.columns);
  const byField = new Map(matches.map(m => [m.field, m]));
  const keyMatches = info.keys.map(k => byField.get(k));
  const keyPresent = info.keys.length > 0 && keyMatches.every(m => m && !m.guessed);
  const keyGuessed = !keyPresent && info.keys.length > 0 && keyMatches.every(m => !!m);
  const credit = (m: FieldMatch) => m.guessed || !m.typeOk ? 0.5 : 1;
  const coverage = info.fields.length ?
      matches.reduce((s, m) => s + credit(m), 0) / info.fields.length :
      0;
  const score = WEIGHTS.name * nameSim + WEIGHTS.key * (keyPresent ? 1 : keyGuessed ? 0.5 : 0) +
      WEIGHTS.coverage * coverage + WEIGHTS.kc * (kcHit ? 1 : 0);
  return {
    table: tableRef(table),
    score: round(score),
    nameSim,
    keyPresent,
    keyGuessed,
    coverage: round(coverage),
    kcHit,
    matches,
    unmatched,
  };
}

export type BindStatus =
    // A table assigned and accepted.
    'auto'|
    // A table (or none) needs a human: the candidates are listed.
    'needs_review'|
    // No table; rows derived from a relationship (hydration.derive_from).
    'derived'|
    // A vocabulary: bound to its generated view.
    'vocabulary'|
    // Abstract, defined or keyless: never gets a table.
    'no_table'|
    // Concrete, but no table and nothing to derive it from.
    'unbound';

export interface EntityBinding {
  entity: string;
  kind: EntityKind;
  status: BindStatus;
  deprecated?: {use?: string};
  // The table bound (auto) or proposed (needs_review).
  chosen?: Candidate;
  // The best candidates, best first (at most 3), the chosen one included.
  candidates: Candidate[];
  // Why the entity has its status, one line each.
  reasons: string[];
  deriveFrom?: {relationship: string; source: string; field: string};
  // A vocabulary's fields whose view column differs from their name.
  vocabFields?: Array<{field: string; column: string}>;
  // A vocabulary's fields with no view column.
  vocabUnbound?: string[];
  // A defined entity's parent (it is a filter over it).
  parent?: string;
}

export interface BindOptions {
  thresholds?: Partial<BindThresholds>;
  // Tables a Knowledge Catalog search for each entity's names returned, by
  // entity name (project.dataset.table refs).
  kcHits?: ReadonlyMap<string, ReadonlySet<string>>;
}

// The generated vocabulary view's columns (see vocabulary.ts).
const VOCAB_COLUMNS = ['code', 'label', 'sort_order', 'definition', 'iri'];

// The name similarity a table needs to a deprecated entity to be its shadow.
const SHADOW_MIN_SIM = 0.5;

function vocabularyColumn(field: Field): string|undefined {
  const ws = words(field.name);
  const last = ws[ws.length - 1];
  if (['label', 'name', 'title'].includes(last)) return 'label';
  if (['order', 'position', 'rank', 'sort', 'sequence'].includes(last)) return 'sort_order';
  if (['definition', 'description'].includes(last)) return 'definition';
  if (['iri', 'uri'].includes(last)) return 'iri';
  return undefined;
}

function bindVocabulary(e: Entity): EntityBinding {
  const vocabFields: Array<{field: string; column: string}> = [];
  const vocabUnbound: string[] = [];
  for (const f of e.fields ?? []) {
    if (e.keys.length === 1 && f.name === e.keys[0]) continue;
    const sn = snakeCase(f.name);
    if (VOCAB_COLUMNS.includes(sn) || sn === 'order') continue;
    const col = vocabularyColumn(f);
    if (col) {
      vocabFields.push({field: f.name, column: col});
    } else {
      vocabUnbound.push(f.name);
    }
  }
  return {
    entity: e.name,
    kind: 'vocabulary',
    status: 'vocabulary',
    candidates: [],
    reasons: [`a vocabulary: bound to its generated view vocab_${snakeCase(e.name)} (code, label, sort_order, definition, iri); no source`],
    vocabFields,
    ...(vocabUnbound.length ? {vocabUnbound} : {}),
  };
}

function flattenedEntities(model: SemanticModel): Map<string, Entity> {
  try {
    return new Map((resolveInheritance(model).model.entities ?? []).map(e => [e.name, e]));
  } catch {
    return new Map((model.entities ?? []).map(e => [e.name, e]));
  }
}

function derivable(r: Relationship, e: Entity): boolean {
  return r.destination.entity === e.name && e.keys.length === 1 &&
      r.destination.columns.length === 1 && r.destination.columns[0] === e.keys[0] &&
      r.source.columns.length === 1 && r.source.entity !== e.name && !r.abstract &&
      !r.via?.length && !r.association;
}

function fmt(n: number): string {
  return n.toFixed(2);
}

/**
 * Steps 1 and 2: a binding decision for every entity of `model` over the
 * scanned `tables`, in model order.
 */
export function bindEntities(
    model: SemanticModel, tables: ScanTable[], options: BindOptions = {}): EntityBinding[] {
  const th = {...DEFAULT_THRESHOLDS, ...(options.thresholds ?? {})};
  const entities = model.entities ?? [];
  const flat = flattenedEntities(model);
  const infos = new Map<string, EntityInfo>();
  const deprecated = new Map<string, {use?: string}>();
  for (const e of entities) {
    const d = deprecation(e);
    if (d) deprecated.set(e.name, d);
    if (entityKind(e) === 'concrete') infos.set(e.name, entityInfo(e, flat.get(e.name)));
  }

  // Every concrete entity against every table.
  const scored = new Map<string, Candidate[]>();
  for (const [name, info] of infos) {
    const hits = options.kcHits?.get(name);
    scored.set(name, tables.map(t => scoreCandidate(info, t, !!hits?.has(tableRef(t))))
                         .sort((a, b) => b.score - a.score || a.table.localeCompare(b.table)));
  }

  // The deprecated-class guard: a table that looks more like a deprecated
  // entity than like this one is that entity's shadow. Only a real
  // resemblance counts (SHADOW_MIN_SIM), so a weak candidate that merely
  // shares a token with some legacy name is not reported as a shadow.
  const simOf = new Map<string, Map<string, number>>();
  for (const [name, cands] of scored) {
    simOf.set(name, new Map(cands.map(c => [c.table, c.nameSim])));
  }
  for (const [name, cands] of scored) {
    if (deprecated.has(name)) continue;
    for (const c of cands) {
      for (const d of deprecated.keys()) {
        const ds = simOf.get(d)?.get(c.table);
        if (ds !== undefined && ds >= SHADOW_MIN_SIM && ds > c.nameSim) {
          c.shadowOf = d;
          break;
        }
      }
    }
  }

  // Greedy exclusive assignment, best pair first.
  const pairs: Array<{entity: string; c: Candidate}> = [];
  for (const [name, cands] of scored) {
    for (const c of cands) {
      if ((c.keyPresent || c.keyGuessed) && !c.shadowOf && c.score >= th.minCandidate) {
        pairs.push({entity: name, c});
      }
    }
  }
  pairs.sort((a, b) => b.c.score - a.c.score || a.entity.localeCompare(b.entity) ||
                 a.c.table.localeCompare(b.c.table));
  const assigned = new Map<string, Candidate>();
  const owner = new Map<string, string>();
  for (const {entity, c} of pairs) {
    if (assigned.has(entity) || owner.has(c.table)) continue;
    assigned.set(entity, c);
    owner.set(c.table, entity);
  }

  // A table whose key column is only guessed loses to derivation: when an
  // edge from a bound entity lands on the key, derive_from is a firm answer
  // where the guessed table could at best be confirmed by a human.
  const rels = [...(model.relationships ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const deriveRel = (e: Entity): Relationship|undefined => rels.find(r => {
    if (!derivable(r, e)) return false;
    const src = assigned.get(r.source.entity);
    return !!src?.keyPresent && src.matches.some(m => m.field === r.source.columns[0]);
  });
  for (const e of entities) {
    const c = assigned.get(e.name);
    if (c && !c.keyPresent && !deprecated.has(e.name) && deriveRel(e)) {
      assigned.delete(e.name);
      owner.delete(c.table);
    }
  }

  const listed = (name: string, chosen?: Candidate): Candidate[] => {
    const cands = (scored.get(name) ?? []).filter(c => c.score >= th.minCandidate);
    for (const c of cands) {
      const o = owner.get(c.table);
      if (o && o !== name) c.takenBy = o;
    }
    const top = cands.slice(0, 3);
    if (chosen && !top.includes(chosen)) top.splice(2, 1, chosen);
    return top;
  };

  const out: EntityBinding[] = [];
  const pendingDerive: EntityBinding[] = [];
  for (const e of entities) {
    const kind = entityKind(e);
    const dep = deprecated.get(e.name);
    const base = {entity: e.name, kind, ...(dep ? {deprecated: dep} : {})};
    if (kind === 'vocabulary') {
      out.push({...bindVocabulary(e), ...(dep ? {deprecated: dep} : {})});
      continue;
    }
    if (kind !== 'concrete') {
      const parent = kind === 'defined' ? e.extends?.[0] : undefined;
      out.push({
        ...base,
        status: 'no_table',
        candidates: [],
        reasons: [kind === 'abstract' ? 'abstract: grouped by its subtypes, no table' :
                  kind === 'defined' ? `defined: a filter over ${parent ?? 'its parent'}, no table` :
                                       'keyless: no key to identify a row, no table'],
        ...(parent ? {parent} : {}),
      });
      continue;
    }
    const chosen = assigned.get(e.name);
    const candidates = listed(e.name, chosen);
    if (!chosen) {
      const b: EntityBinding = {
        ...base,
        status: 'unbound',
        candidates,
        reasons: [],
      };
      const best = (scored.get(e.name) ?? [])[0];
      if (best?.takenBy) {
        b.reasons.push(`best table ${best.table} (score ${fmt(best.score)}) is bound to ${best.takenBy}, which scores higher on it`);
      }
      if (best?.shadowOf) {
        b.reasons.push(`best table ${best.table} looks more like deprecated ${best.shadowOf}`);
      }
      out.push(b);
      pendingDerive.push(b);
      continue;
    }
    const rivals = (scored.get(e.name) ?? []).filter(c => c !== chosen && !c.shadowOf);
    const runnerUp = rivals[0];
    const margin = chosen.score - (runnerUp?.score ?? 0);
    const reasons: string[] = [];
    if (!chosen.keyPresent) {
      reasons.push(`no column matches key ${e.keys.join(', ')}${chosen.keyGuessed ?
          ` (guessed: ${chosen.matches.filter(m => m.guessed).map(m => m.column).join(', ')})` : ''}`);
    }
    if (chosen.coverage < th.coverage) {
      reasons.push(`field coverage ${fmt(chosen.coverage)} < ${fmt(th.coverage)}`);
    }
    if (margin < th.margin) {
      reasons.push(`margin ${fmt(margin)} over ${runnerUp?.table ?? 'no runner-up'} < ${fmt(th.margin)}`);
    }
    const auto = !reasons.length;
    if (auto) {
      reasons.push(`key matched, coverage ${fmt(chosen.coverage)}, margin ${fmt(margin)}${
          runnerUp ? ` over ${runnerUp.table}` : ''}`);
    }
    const shadows = (scored.get(e.name) ?? []).filter(c => c.shadowOf && c.score >= th.minCandidate);
    for (const s of shadows) {
      reasons.push(`not bound to ${s.table}: looks more like deprecated ${s.shadowOf}`);
    }
    out.push({...base, status: auto ? 'auto' : 'needs_review', chosen, candidates, reasons});
  }

  // Derivation, once every table is placed.
  const byName = new Map(out.map(b => [b.entity, b]));
  for (const b of pendingDerive) {
    const e = entities.find(x => x.name === b.entity)!;
    const rel = rels.find(r => {
      if (!derivable(r, e)) return false;
      const src = byName.get(r.source.entity);
      return !!src?.chosen?.matches.some(m => m.field === r.source.columns[0]);
    });
    if (rel) {
      const src = byName.get(rel.source.entity)!;
      const col = src.chosen!.matches.find(m => m.field === rel.source.columns[0])!.column;
      b.status = 'derived';
      b.deriveFrom = {relationship: rel.name, source: rel.source.entity, field: rel.source.columns[0]};
      b.reasons.unshift(`no table of its own; its key ${e.keys[0]} is ${rel.source.entity}.${
          rel.source.columns[0]} (column ${col}) on relationship ${rel.name}: derive_from ${rel.name}`);
    } else if (b.candidates.some(c => c.keyPresent || c.keyGuessed)) {
      b.status = 'needs_review';
      b.reasons.push('no table assigned; confirm a candidate');
    } else {
      b.reasons.push('no table holds its key, and no relationship to derive it from');
    }
  }
  return out;
}

/** Counts per status, and the auto-accepted share of concrete entities. */
export function bindSummary(bindings: EntityBinding[]): {
  counts: Record<BindStatus, number>;
  concrete: number;
  accepted: number;
  acceptedShare: number;
} {
  const counts: Record<BindStatus, number> = {
    auto: 0, needs_review: 0, derived: 0, vocabulary: 0, no_table: 0, unbound: 0,
  };
  for (const b of bindings) counts[b.status]++;
  const concrete = bindings.filter(b => b.kind === 'concrete').length;
  const accepted = counts.auto + counts.derived;
  return {counts, concrete, accepted, acceptedShare: concrete ? round(accepted / concrete) : 1};
}
