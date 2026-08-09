// Serializes the Semantic Model IR (./ir) back to the open AI-first semantics
// format (YAML). This is the inverse of `loader.ts`: `loader` reads authored
// YAML into the IR; this module writes the IR out as a YAML document the loader
// can read back. It is the local-workspace sink for `pull` (Knowledge Catalog
// -> IR -> YAML), the counterpart to how `push` compiles YAML -> IR -> a
// destination.
//
// Fidelity is at the IR level, not byte-for-byte with a hand-authored file. The
// loader normalizes several authoring conveniences into the IR at load time, so
// they are already gone before serialization and cannot be reproduced here:
//   * per-dialect `expression.dialects[]` variants collapse to at most two
//   forms
//     (a target/canonical `expression` + an `importedExpression`); only those
//     are re-emitted, each under a single dialect label.
//   * comments and key ordering are not preserved.
// What the loader DOES keep on the IR round-trips here: names, descriptions,
// `ai_context` (instructions / synonyms / examples), `custom_extensions`
// (verbatim), keys and unique keys, data sources, field datatypes / labels /
// dimension flags, expressions, and relationship join columns. See
// serialize.test.ts.
//
// An `association` (junction-table) relationship has no open-format syntax (the
// loader cannot produce one), so only its direct foreign-key view (from/to +
// columns) is serialized; the junction detail is dropped with a note.

import * as yaml from 'yaml';

import {AiContext, CustomExtension, Entity, Field, Metric, Relationship, SemanticModel,} from './ir';

// The schema version the loader was written against; re-emitted verbatim so a
// serialized document loads without a version-mismatch warning. Mirrors
// loader.SUPPORTED_VERSION.
const SERIALIZED_VERSION = '0.2.0.dev0';

// The dialect label for the IR's target/canonical `expression`. The IR does not
// record which authored dialect that string came from (the loader picked it
// from the target dialect or the ANSI_SQL fallback and discarded the label),
// and its contract is "GoogleSQL-valid". BIGQUERY is the loader's default
// target dialect, so labeling the canonical form BIGQUERY makes the loader
// re-pick it exactly on reload -- a clean round trip with no dialect-fallback
// note.
const CANONICAL_DIALECT = 'BIGQUERY';

// The dialect label used for an `importedExpression` whose `importedDialect`
// was lost (e.g. read back from a Knowledge Catalog aspect that does not
// persist the dialect). A non-target, non-canonical label so the loader
// re-reads it as the imported vendor form rather than the canonical expression.
const UNKNOWN_IMPORTED_DIALECT = 'IMPORTED';

export interface SerializeResult {
  yaml: string;
  warnings: string[];
}

/**
 * Serializes a single semantic model to a YAML document string in the open
 * AI-first semantics format. The document contains exactly this one model;
 * `pull` writes one file per model
 * (catalog/EntryGroups/<entryGroup>/<model>.yaml).
 *
 * Warnings flag IR content that has no loadable representation (an association
 * relationship's junction detail), so the caller can surface the lossy edge.
 */
export function serializeModel(model: SemanticModel): SerializeResult {
  const warnings: string[] = [];
  const text = yaml.stringify(modelDocument(model, warnings));
  return {yaml: text, warnings: [...new Set(warnings)]};
}

// Builds the plain document object (version + one model) that yaml.stringify
// renders. Kept separate so tests can assert the structure without parsing
// YAML.
export function modelDocument(
    model: SemanticModel, warnings: string[] = []): Record<string, any> {
  return {
    version: SERIALIZED_VERSION,
    semantic_model: [modelDoc(model, warnings)],
  };
}

function modelDoc(
    model: SemanticModel, warnings: string[]): Record<string, any> {
  // `datasets` is required (min 1) by the loader. A reconstructed model with no
  // entities (e.g. every entity fetch failed during a pull) would serialize to
  // a document the loader rejects; emit the (empty) array but flag it so the
  // lossy edge is visible rather than surfacing later as an opaque load error.
  const datasets = (model.entities ?? []).map(e => datasetDoc(e, warnings));
  if (!datasets.length) {
    warnings.push(
        `model '${model.name}': no datasets (entities); the document requires ` +
        `at least one and will not load until an entity is present.`);
  }
  return compact({
    name: model.name,
    description: model.description,
    ai_context: aiContextDoc(model.aiContext),
    custom_extensions: customExtensionsDoc(model.customExtensions),
    datasets,
    relationships: nonEmpty(
        (model.relationships ?? []).map(r => relationshipDoc(r, warnings))),
    metrics: nonEmpty((model.metrics ?? []).map(m => metricDoc(m, warnings))),
  });
}

function datasetDoc(
    entity: Entity, warnings: string[]): Record<string, any> {
  return compact({
    name: entity.name,
    source: entity.dataSource,
    primary_key: nonEmpty(entity.keys),
    unique_keys: nonEmpty(entity.uniqueKeys),
    description: entity.description,
    ai_context: aiContextDoc(entity.aiContext),
    fields: nonEmpty((entity.fields ?? []).map(f => fieldDoc(f, warnings))),
    custom_extensions: customExtensionsDoc(entity.customExtensions),
  });
}

function fieldDoc(field: Field, warnings: string[]): Record<string, any> {
  const expression = expressionDoc(
      field.expression, field.importedExpression, field.importedDialect);
  if (!expression) {
    warnings.push(
        `field '${field.name}': no expression; the loader requires one per ` +
        `field and the document will not load until it is set.`);
  }
  return compact({
    name: field.name,
    expression,
    datatype: field.type,
    label: field.label,
    dimension: dimensionDoc(field),
    description: field.description,
    ai_context: aiContextDoc(field.aiContext),
    custom_extensions: customExtensionsDoc(field.customExtensions),
  });
}

function metricDoc(metric: Metric, warnings: string[]): Record<string, any> {
  // `entity` is derived by the loader from the expression's entity qualifiers,
  // so it is intentionally not emitted: the loader recomputes it on reload.
  const expression = expressionDoc(
      metric.expression, metric.importedExpression, metric.importedDialect);
  if (!expression) {
    warnings.push(
        `metric '${metric.name}': no expression; the loader requires one per ` +
        `metric and the document will not load until it is set.`);
  }
  return compact({
    name: metric.name,
    expression,
    datatype: metric.type,
    description: metric.description,
    ai_context: aiContextDoc(metric.aiContext),
    custom_extensions: customExtensionsDoc(metric.customExtensions),
  });
}

// Inverts loader.convertRelationship: `from`/`to` are the endpoint entities and
// `from_columns`/`to_columns` are their positional join columns. An association
// (junction-table) edge has no open-format syntax, so only this direct-FK view
// is emitted and the junction detail is flagged.
function relationshipDoc(
    rel: Relationship, warnings: string[]): Record<string, any> {
  if (rel.association) {
    warnings.push(
        `relationship '${
            rel.name}': association (junction-table) detail has no ` +
        `open-format representation and is not serialized; only its foreign-key ` +
        `endpoints are written.`);
  }
  return compact({
    name: rel.name,
    from: rel.source.entity,
    to: rel.destination.entity,
    from_columns: nonEmpty(rel.source.columns),
    to_columns: nonEmpty(rel.destination.columns),
    description: rel.description,
    ai_context: aiContextDoc(rel.aiContext),
    custom_extensions: customExtensionsDoc(rel.customExtensions),
  });
}

// Renders the `expression` object matching the loader's schema (a `dialects`
// array of {dialect, expression}). Emits the target/canonical form under
// CANONICAL_DIALECT and the imported vendor form under its own dialect, so the
// loader re-picks each into the same IR field. Returns undefined when neither
// form is present (the loader requires an expression, but a pathological field
// with none is dropped rather than fabricated).
function expressionDoc(
    expression: string|undefined, importedExpression: string|undefined,
    importedDialect: string|undefined): Record<string, any>|undefined {
  const dialects: {dialect: string; expression: string}[] = [];
  if (expression !== undefined) {
    dialects.push({dialect: CANONICAL_DIALECT, expression});
  }
  if (importedExpression !== undefined) {
    let label = importedDialect ?? UNKNOWN_IMPORTED_DIALECT;
    // Never emit two dialect entries under the same label: the loader would
    // pick between them non-deterministically. If the imported form's dialect
    // collides with the canonical label already pushed, fall back to the
    // imported placeholder.
    if (expression !== undefined && label === CANONICAL_DIALECT) {
      label = UNKNOWN_IMPORTED_DIALECT;
    }
    dialects.push({dialect: label, expression: importedExpression});
  }
  return dialects.length ? {dialects} : undefined;
}

// Emits the field's `dimension` block when present, inverting
// loader.convertField (which sets `dimension = {}` for a bare marker and copies
// `is_time`). The key is emitted whenever the IR carries dimension metadata,
// even for an empty marker, so a dimension field reloads as a dimension.
function dimensionDoc(field: Field): Record<string, any>|undefined {
  if (!field.dimension) return undefined;
  return compact({is_time: field.dimension.isTime});
}

// Emits the structured `ai_context` (the only authoring path the loader reads
// synonyms/instructions/examples from), inverting loader.normalizeAiContext.
// Returns undefined when the context carries nothing, so `compact` drops the
// key.
function aiContextDoc(ai: AiContext|undefined): Record<string, any>|undefined {
  if (!ai) return undefined;
  const doc = compact({
    instructions: ai.instructions,
    synonyms: nonEmpty(ai.synonyms),
    examples: nonEmpty(ai.examples),
  });
  return Object.keys(doc).length ? doc : undefined;
}

// Emits vendor `custom_extensions` verbatim (`vendorName` -> `vendor_name`),
// inverting loader.toCustomExtensions. Returns undefined when there are none.
function customExtensionsDoc(exts: CustomExtension[]|undefined):
    Record<string, any>[]|undefined {
  if (!exts || !exts.length) return undefined;
  return exts.map(e => ({vendor_name: e.vendorName, data: e.data}));
}

// Drops undefined-valued keys so the emitted YAML only shows fields the model
// actually set (matching the emitters' `compact` convention).
function compact<T extends Record<string, any>>(obj: T): T {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}

// Returns the array, or undefined when empty/absent, so an empty list is
// omitted rather than rendered as `[]`.
function nonEmpty<T>(items: T[]|undefined): T[]|undefined {
  return items && items.length ? items : undefined;
}
