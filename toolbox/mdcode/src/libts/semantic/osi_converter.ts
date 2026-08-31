// OSI (open, AI-first semantics) <-> Semantic Model IR converter.
//
// SCAFFOLD (naming for the end state): this file currently holds only the
// WRITE direction -- IR -> OSI YAML (`serializeModel`). The READ direction
// (OSI YAML -> IR) still lives in `loader.ts` and moves here once PR4 (the
// KC push line) merges, at which point this becomes the full two-way
// converter. Until then, "where is the OSI parser?" -> `loader.ts`.
//
// TODO(#278): fold the OSI READ direction in and drop the scaffold. Once
// #278 merges, move `loadModels` / `fromDocument` / `loadSemanticModels`
// (and their Load* types) out of `loader.ts` into this file, delete
// `loader.ts`, and repoint its importers (`src/tool/commands.ts` and the
// load / validate / bigquery tests). Then this is the sole OSI<->IR codec
// and the SCAFFOLD note above comes out.
//
// Serializing is the inverse of `loader.ts`: `loader` reads authored YAML
// into the IR; this module writes the IR out as a YAML document the loader
// can read back. It is the local-workspace sink for `pull` (Knowledge
// Catalog -> IR -> YAML), the counterpart to how `push` compiles YAML -> IR
// -> a destination.
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

import {Action, AiContext, CustomExtension, Entity, Executor, Field, Metric, Relationship, SemanticModel,} from './ir';

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
 *
 * `logical` marks the model as a purely logical one (no physical binding), so
 * the missing-source and missing-expression warnings -- which flag a lossy pull
 * of a bound model -- are suppressed. An OWL import sets it; `pull` does not.
 *
 * `compactFlow` renders leaf collections (scalar sequences, all-scalar maps) in
 * flow style so the output matches the compact convention the semantic-model
 * guides author by hand and is byte-for-byte reproducible there. An OWL import
 * sets it; `pull` does not.
 */
export interface SerializeOptions {
  logical?: boolean;
  compactFlow?: boolean;
}

export function serializeModel(
    model: SemanticModel, opts: SerializeOptions = {}): SerializeResult {
  const warnings: string[] = [];
  const document = modelDocument(model, warnings, opts.logical);
  const text =
      opts.compactFlow ? renderCompact(document) : yaml.stringify(document);
  return {yaml: text, warnings: [...new Set(warnings)]};
}

// Renders "leaf" collections in flow style so the output matches the compact
// convention the semantic-model guides author by hand: a sequence whose items
// are all scalars (`primary_key: [id]`, `from_columns: [fk]`) and a map whose
// values are all scalars (an inline field `{name, datatype}` or a column-less
// relationship `{name, from, to}`). Nested structures -- a dataset, an
// expression's `dialects`, an `ai_context` -- always stay block.
//
// A leaf collection is inlined ONLY while it stays short: a map or sequence
// whose flow form would exceed FLOW_WIDTH_BUDGET (a field carrying a long
// `description`, say) is left block, so `--compact` never emits an unreadable
// multi-hundred-character line. `lineWidth: 0` disables the wrapper so an
// inlined collection is never broken mid-braces -- the width gate, not the
// wrapper, is what bounds line length. Flow and block parse identically, so
// this only affects layout.
const FLOW_WIDTH_BUDGET = 80;

// The rendered width of a scalar node (its stringified value length); 0 for a
// non-scalar, which never contributes because a collection holding one is not
// inlined in the first place.
function scalarWidth(node: unknown): number {
  return yaml.isScalar(node) ?
      String((node as yaml.Scalar).value ?? '').length :
      0;
}

function renderCompact(document: Record<string, any>): string {
  const doc = new yaml.Document(document);
  yaml.visit(doc, {
    Seq(_, node) {
      if (!node.items.every(item => yaml.isScalar(item))) return;
      // `[` + each `item, ` + `]`, approximated for the width gate.
      const width = node.items.reduce((n, item) => n + scalarWidth(item) + 2, 2);
      if (width <= FLOW_WIDTH_BUDGET) node.flow = true;
    },
    Map(_, node) {
      const pairs = node.items as yaml.Pair[];
      if (!pairs.every(pair => yaml.isScalar(pair.value))) return;
      // `{` + each `key: value, ` + `}`, approximated for the width gate.
      const width = pairs.reduce(
          (n, pair) => n + scalarWidth(pair.key) + scalarWidth(pair.value) + 4,
          2);
      if (width <= FLOW_WIDTH_BUDGET) node.flow = true;
    },
  });
  return doc.toString({flowCollectionPadding: false, lineWidth: 0});
}

// Builds the plain document object (version + one model) that yaml.stringify
// renders. Kept separate so tests can assert the structure without parsing
// YAML.
export function modelDocument(
    model: SemanticModel, warnings: string[] = [],
    logical = false): Record<string, any> {
  return {
    version: SERIALIZED_VERSION,
    semantic_model: [modelDoc(model, warnings, logical)],
  };
}

function modelDoc(model: SemanticModel, warnings: string[], logical: boolean):
    Record<string, any> {
  // `datasets` is required (min 1) by the loader. A reconstructed model with no
  // entities (e.g. every entity fetch failed during a pull) would serialize to
  // a document the loader rejects; emit the (empty) array but flag it so the
  // lossy edge is visible rather than surfacing later as an opaque load error.
  const datasets =
      (model.entities ?? []).map(e => datasetDoc(e, warnings, logical));
  if (!datasets.length) {
    warnings.push(
        `model '${
            model.name}': no datasets (entities); the document requires ` +
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
    actions: nonEmpty((model.actions ?? []).map(a => actionDoc(a))),
  });
}

function datasetDoc(
    entity: Entity, warnings: string[], logical: boolean): Record<string, any> {
  // A concrete (non-abstract) entity with no source cannot be reloaded -- the
  // loader requires `source` unless the dataset is abstract -- so surface the
  // gap at write time instead of emitting a document that fails to load. This
  // never fires for a well-formed IR; it catches a lossy pull that dropped a
  // binding without marking the entity abstract. Suppressed for a logical
  // model, where a missing source is intended (a binding profile supplies it
  // later).
  if (!logical && !entity.abstract && !entity.dataSource) {
    warnings.push(
        `entity '${entity.name}' has no source and is not abstract; the ` +
        `serialized document will not reload until a source is set`);
  }
  return compact({
    name: entity.name,
    // An abstract entity has no physical table, so its source is empty; omit
    // the key rather than emit `source: ""` (which the loader reads as a
    // concrete-but-empty reference).
    source: entity.dataSource || undefined,
    // Supertype entities (entity-level inheritance); omitted when none.
    extends: nonEmpty(entity.extends),
    // Conceptual (table-less) marker; omitted when false/absent.
    abstract: entity.abstract || undefined,
    primary_key: nonEmpty(entity.keys),
    unique_keys: nonEmpty(entity.uniqueKeys),
    description: entity.description,
    ai_context: aiContextDoc(entity.aiContext),
    fields: nonEmpty(
        (entity.fields ?? []).map(f => fieldDoc(f, warnings, logical))),
    custom_extensions: customExtensionsDoc(entity.customExtensions),
  });
}

function fieldDoc(
    field: Field, warnings: string[], logical: boolean): Record<string, any> {
  const expression = expressionDoc(
      field.expression, field.importedExpression, field.importedDialect);
  // A logical field intentionally has no expression (a binding profile maps it
  // to a column later), so the missing-expression warning is suppressed there;
  // for a bound model it still flags a lossy pull.
  if (!logical && !expression) {
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

// Inverts loader.convertAction. The executor collapses back to the open
// format's single-key object; parameters emit as {name, type}. `isEntityRef` is
// derived by the loader on reload, so it is intentionally not emitted.
function actionDoc(action: Action): Record<string, any> {
  return compact({
    name: action.name,
    description: action.description,
    executor: executorDoc(action.executor),
    parameters: nonEmpty(
        (action.parameters ?? []).map(p => ({name: p.name, type: p.type}))),
    ai_context: aiContextDoc(action.aiContext),
    custom_extensions: customExtensionsDoc(action.customExtensions),
  });
}

// Collapses the IR's tagged executor union back to the open format's single-key
// object ({mcp: {...}} / {rest: {...}} / {grpc: {...}}).
function executorDoc(ex: Executor): Record<string, any> {
  switch (ex.kind) {
    case 'mcp':
      return {mcp: {server: ex.mcp.server, tool: ex.mcp.tool}};
    case 'rest':
      return {rest: {endpoint: ex.rest.endpoint, method: ex.rest.method}};
    case 'grpc':
      return {grpc: {service: ex.grpc.service, method: ex.grpc.method}};
  }
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
