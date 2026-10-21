// Leaf helpers for action parameter optionality, scalar type checking, and
// store type codes -- shared by deploy-time validation and run-time execution
// without pulling store clients into the validation layer.

import {ActionParameter} from './ir';

export function isParameterRequired(param: ActionParameter): boolean {
  if (param.required !== undefined) return param.required;
  return param.default === undefined;
}

export function storeCodeFor(dataType: string): string {
  switch (dataType) {
    case 'Integer':
      return 'INT64';
    case 'Float':
      return 'FLOAT64';
    case 'Decimal':
      return 'NUMERIC';
    case 'Boolean':
      return 'BOOL';
    case 'Date':
      return 'DATE';
    case 'DateTime':
    case 'DateTimeTz':
      return 'TIMESTAMP';
    default:
      return 'STRING';
  }
}

// Ends a fragment that is about to be followed by another sentence.
export function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

// What Spanner accepts for a DATE and a TIMESTAMP parameter. The zone is
// required rather than defaulted, because a timestamp written without one
// means a different instant to every reader who supplies the missing part.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RFC3339_TIMESTAMP =
    /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[-+]\d{2}:?\d{2})$/;

// Whether `text` is a day that exists, written the one way Spanner reads.
// `Date.parse` answers neither question: it accepts '03/04/2026', and it reads
// '2026-02-30' as the second of March rather than rejecting it. A round trip
// answers both, because a day that rolled over comes back written differently.
function isCalendarDay(text: string): boolean {
  if (!ISO_DATE.test(text)) return false;
  const utc = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(utc.getTime()) && utc.toISOString().startsWith(text);
}

/**
 * One value, parsed to the store type its declared ontology type implies.
 *
 * Exported because a read has the same problem a write does: a filter on a
 * typed column has to be bound AS that type, or the predicate needs a cast and
 * no index can answer it. Sharing this also means one answer to what counts as
 * an Integer or a Date, rather than one for writes and another for reads.
 */
export function bindScalar(
    param: ActionParameter, raw: unknown): {value: unknown; code: string}|{
  error: string
}
{
  // A parameter whose type resolved to nothing. The loader warns and validate
  // refuses to push such a model, so this is reached only through the library
  // entry point -- and there is no type to parse the value against, so there
  // is nothing to bind.
  const type = param.type;
  if (type === undefined) {
    return {
      error: `Action parameter '${param.name}' has no type: it states no ` +
          `scalar 'type' and projects no field that supplies one, so a value ` +
          `cannot be bound to it.`,
    };
  }
  // Everything below stringifies the value before matching it against the
  // type, which is what lets a JSON `"12347"` bind as an Integer. An object or
  // an array has a string form too -- `[object Object]` -- and it would sail
  // through as a String and be written to the store verbatim. A parameter
  // carries ONE scalar, so a composite is refused here rather than flattened.
  if (raw !== undefined && raw !== null && typeof raw === 'object') {
    return {
      error: `Action parameter '${param.name}' (${type}) was given ${
                 Array.isArray(raw) ? 'a list' :
                                      'an object'}, but a parameter ` +
          `carries a single scalar value.`,
    };
  }
  // An empty String IS a value: `--arg memo=` is the caller saying the memo is
  // blank, which is a different statement from not passing one. For every
  // other type there is no value empty text could be, so it stays an error.
  if (raw === undefined || raw === null ||
      (`${raw}`.trim() === '' && type !== 'String')) {
    return {
      error: `Action parameter '${param.name}' (${type}) was not given ` +
          `a value.`,
    };
  }
  const text = `${raw}`.trim();
  const code = storeCodeFor(type);
  switch (type) {
    case 'Integer':
      if (!/^[-+]?\d+$/.test(text)) {
        return {error: `'${param.name}' is an Integer, but '${text}' is not.`};
      }
      // INT64 travels as a string over the REST surface; a JSON number would
      // lose precision above 2^53.
      return {value: text, code};
    case 'Float':
      if (!Number.isFinite(Number(text))) {
        return {error: `'${param.name}' is a Float, but '${text}' is not.`};
      }
      return {value: Number(text), code};
    case 'Decimal':
      if (!/^[-+]?\d+(\.\d+)?$/.test(text)) {
        return {error: `'${param.name}' is a Decimal, but '${text}' is not.`};
      }
      // NUMERIC travels as a string, for the same reason: an exact decimal
      // routed through a JSON number stops being exact.
      return {value: text, code};
    case 'Boolean':
      if (!/^(true|false)$/i.test(text)) {
        return {error: `'${param.name}' is a Boolean, but '${text}' is not.`};
      }
      return {value: /^true$/i.test(text), code};
    case 'Date':
      // Spanner reads a DATE as YYYY-MM-DD and nothing else. '03/04/2026' is
      // the fourth of March to one reader and the third of April to another,
      // so the shape is checked -- and then the calendar, because a shape is
      // not a day.
      if (!isCalendarDay(text)) {
        return {
          error: `'${param.name}' is a Date, but '${
              text}' is not one. Dates are written YYYY-MM-DD.`,
        };
      }
      return {value: text, code};
    case 'DateTime':
    case 'DateTimeTz':
      if (!RFC3339_TIMESTAMP.test(text) || !isCalendarDay(text.slice(0, 10))) {
        return {
          error: `'${param.name}' is a ${type}, but '${
                     text}' is not a timestamp. Timestamps are written like ` +
              `2026-03-04T10:00:00Z, with the zone.`,
        };
      }
      return {value: text, code};
    default:
      // `raw`, not `text`. The trim above exists to parse a number or a date
      // off a command line; a String parameter is not parsed, it IS the value.
      // Trimming here would store `see ticket` for `--arg memo=" see ticket "`
      // -- the caller's text altered on the way to the store, by a rule
      // nothing states.
      return {value: `${raw}`, code};
  }
}
