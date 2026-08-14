// The `sql-expressions` companion aspect: the shared codec both KC push and
// pull use to move SQL out of the metadata-only system aspects.
//
// Per the V2 "SQL Expression Storage in USL Semantic Models" proposal
// (D. Lychagin, 2026-08-13), executable SQL is NOT stored on the metadata-only
// `schema` / `semantic-metric` aspects. It lives in a single, general-purpose
// `sql-expressions` aspect (data_classification: METADATA_AND_DATA) attached to
// the same entry, so catalog metadata discovery stays open while the SQL is
// governed behind data-level access. This module is the one place that fixes
// the aspect's shape and its qualifier convention; the emitter
// (`knowledge_catalog.ts`) and the reader (`kc_converter.ts`) are exact
// inverses over it, which is what keeps a push -> pull round trip lossless.
//
// Shape (mirroring `descriptions.textproto`'s dual-level pattern):
//   {
//     expressions?: [{ qualifier?, sql }, ...]         // entry-level (metrics)
//     fields?: [{ name, expressions: [{ qualifier?, sql }, ...] }, ...]  // per
//     field
//   }
//
// Qualifier convention (open taxonomy server-side; the subset we author):
//   * omitted    -> the primary / canonical GoogleSQL expression  (IR
//   `expression`)
//   * "imported" -> the source-dialect expression, verbatim       (IR
//   `importedExpression`)
// The specific source dialect is intentionally NOT stored here (the proposal
// infers it from the entity's `importedSystem`); an imported record therefore
// reads back as `importedExpression` with the dialect left for a later pass.

// Bare aspect-type id, matched by suffix on read so the system-type
// project/location need not be known (see kc_converter.aspectDataOf).
export const SQL_EXPRESSIONS_ASPECT = 'sql-expressions';

// The one qualifier value we author beyond the (omitted) primary expression.
export const IMPORTED_QUALIFIER = 'imported';

// One SQL expression record: the raw SQL plus an optional role/dialect
// qualifier. `qualifier` is omitted for the primary GoogleSQL expression.
export interface SqlExpressionRecord {
  qualifier?: string;
  sql: string;
}

// One field's expression records, bound to the schema field of the same name.
export interface SqlFieldExpressions {
  name: string;
  expressions: SqlExpressionRecord[];
}

// The `sql-expressions` aspect data payload. Both arrays are optional; the
// aspect is only attached when at least one is non-empty.
export interface SqlExpressionsData {
  expressions?: SqlExpressionRecord[];
  fields?: SqlFieldExpressions[];
}

/**
 * The expression records for one IR element (field or metric): the primary
 * GoogleSQL form (unqualified) and/or the imported vendor form (qualifier
 * `imported`), in that order. Returns [] when neither form is set, so a caller
 * can decide whether to attach the aspect at all.
 */
export function expressionRecords(
    expression: string|undefined,
    importedExpression: string|undefined): SqlExpressionRecord[] {
  const records: SqlExpressionRecord[] = [];
  if (expression !== undefined) records.push({sql: expression});
  if (importedExpression !== undefined) {
    records.push({qualifier: IMPORTED_QUALIFIER, sql: importedExpression});
  }
  return records;
}

// The IR expression forms recovered from a records array.
export interface RecoveredExpressions {
  expression?: string;
  importedExpression?: string;
}

/**
 * The inverse of `expressionRecords`: recovers the primary and imported forms
 * from an expression-records array. A record whose `qualifier` is omitted (or
 * empty) is the primary GoogleSQL expression; a record qualified `imported` is
 * the vendor form. The source dialect is not stored, so only `importedExpression`
 * (not its dialect) comes back. The first record of each kind wins; malformed
 * records (no `sql`) and records with any other qualifier are ignored.
 */
export function recoverExpressions(records: SqlExpressionRecord[]|undefined):
    RecoveredExpressions {
  const out: RecoveredExpressions = {};
  for (const rec of records ?? []) {
    if (!rec || typeof rec.sql !== 'string') continue;
    if (rec.qualifier === IMPORTED_QUALIFIER) {
      if (out.importedExpression === undefined)
        out.importedExpression = rec.sql;
    } else if (rec.qualifier === undefined || rec.qualifier === '') {
      if (out.expression === undefined) out.expression = rec.sql;
    }
    // Any other qualifier (future filter/sql_on/... roles) is not part of the
    // field/metric expression model yet and is skipped rather than guessed.
  }
  return out;
}
