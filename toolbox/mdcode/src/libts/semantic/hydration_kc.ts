// The Knowledge Catalog encoding of an entity's binding mode and hydration
// rules (see hydration.ts).
//
// The `semantic-entity` aspect has no slot for them, so they ride the entity
// entry's description as one fixed, parseable trailing paragraph -- the
// convention K1 / K3 / K7 use for what the closed templates cannot hold:
//
//   <description + other trailers>
//
//   Hydration: latest version per opportunity_id by created_at; wonAmount ÷100 before 2024-03-25.
//
// `kcmd pull` peels the paragraph back off into the entity's `hydration` and
// `mode`. Everything about the encoding lives in this module, so moving it to
// a dedicated aspect later changes only these two functions.

import {Entity, EntityBindingMode, EntityHydration, NormalizeRule, ResolveRule} from './ir';
import {hydrationClauses} from './hydration';

/** The prefix of the hydration paragraph on a published entity description. */
export const HYDRATION_PREFIX = 'Hydration: ';

const DIRECT_CLAUSE = 'bound directly (no node view)';

/**
 * The hydration paragraph an entity's catalog entry carries, or undefined
 * when the entity declares no hydration and is bound through its node view
 * (the default). `destinationOf` names the entity a resolved field's
 * relationship points to, for the reader.
 */
export function hydrationTrailer(
    entity: Pick<Entity, 'keys'|'hydration'|'mode'>,
    destinationOf?: (field: string) => string | undefined): string|undefined {
  const clauses = hydrationClauses(entity, destinationOf);
  return clauses.length ? `${HYDRATION_PREFIX}${clauses.join('; ')}.` :
                          undefined;
}

const IDENT = '[A-Za-z_][A-Za-z0-9_]*';
const LATEST = new RegExp(`^latest version per .+ by (${IDENT})$`);
const DETERMINISTIC = /^one row per .+ \(deterministic pick\)$/;
const NORMALIZE = new RegExp(
    `^(${IDENT}) ([÷×])([0-9]+(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?) ` +
    `(before|from) (\\S+?)(?: by (${IDENT}))?$`);
const RESOLVE = new RegExp(`^(${IDENT}) resolved(?: to \\S+)? by (.+)$`);
const DERIVED = /^derived from (\S+)$/;

/**
 * Peels the hydration paragraph (see hydrationTrailer) off the end of a
 * pulled entity description. Text without one -- or with a paragraph that
 * does not parse in full -- is returned untouched.
 */
export function splitHydrationTrailer(text: string|undefined): {
  rest: string|undefined;
  hydration?: EntityHydration;
  mode?: EntityBindingMode;
} {
  if (text === undefined) return {rest: undefined};
  const paragraphs = text.split('\n\n');
  const last = paragraphs[paragraphs.length - 1];
  if (!last.startsWith(HYDRATION_PREFIX) || !last.endsWith('.')) {
    return {rest: text};
  }
  const body = last.slice(HYDRATION_PREFIX.length, -1);
  const h: EntityHydration = {};
  let mode: EntityBindingMode|undefined;
  for (const clause of body.split('; ')) {
    let m: RegExpExecArray|null;
    if (clause === DIRECT_CLAUSE) {
      mode = 'direct';
    } else if ((m = LATEST.exec(clause))) {
      h.grain = {latestBy: m[1]};
    } else if (DETERMINISTIC.test(clause)) {
      h.grain = {deterministic: true};
    } else if ((m = NORMALIZE.exec(clause))) {
      const n = Number(m[3]);
      const rule: NormalizeRule = {field: m[1]};
      if (m[4] === 'before') {
        rule.before = m[5];
      } else {
        rule.after = m[5];
      }
      if (m[2] === '÷') {
        rule.divideBy = n;
      } else {
        rule.multiplyBy = n;
      }
      if (m[6] !== undefined) rule.on = m[6];
      (h.normalize ??= []).push(rule);
    } else if ((m = RESOLVE.exec(clause))) {
      const match = m[2].split(' or ').map(s => s.trim());
      if (!match.every(s => new RegExp(`^${IDENT}$`).test(s))) {
        return {rest: text};
      }
      (h.resolve ??= []).push({field: m[1], match} as ResolveRule);
    } else if ((m = DERIVED.exec(clause))) {
      h.deriveFrom = {relationship: m[1]};
    } else {
      return {rest: text};
    }
  }
  const restText = paragraphs.slice(0, -1).join('\n\n');
  const out: {rest: string|undefined; hydration?: EntityHydration;
              mode?: EntityBindingMode} = {
    rest: restText === '' ? undefined : restText,
  };
  if (Object.keys(h).length) out.hydration = h;
  if (mode) out.mode = mode;
  return out;
}
