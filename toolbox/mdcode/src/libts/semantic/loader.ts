// Loads an open, vendor-neutral AI-first semantics format (YAML/JSON) into the
// Semantic Model IR (./ir).
//
// The format describes a semantic model as datasets (entities), foreign-key
// relationships, and model-level metrics, with entity-qualified SQL expressions
// (`Entity.column`) supplied per SQL dialect. This module reads the subset of
// that logical layer needed to normalize a model into the IR, so the rest of the
// toolbox (e.g. the BigQuery property-graph generator) can consume models
// authored in it. Fields outside the supported subset are accepted and ignored.
//

import * as yaml from 'yaml';
import * as z from 'zod';
import {
  SemanticModel, Entity, Field, Relationship, Metric, AiContext, CustomExtension,
  DATA_TYPES,
} from './ir';
import { referencedEntityNames } from './sql_expr_utils';

export interface LoadOptions {
  dialect?: string;         // preferred expression dialect; default 'BIGQUERY'
  defaultProject?: string;  // fallback when a dataset `source` omits the project
  defaultDataset?: string;  // fallback when a dataset `source` omits the dataset
}

export interface LoadResult {
  models: SemanticModel[];
  warnings: string[];
}

const DEFAULT_DIALECT = 'BIGQUERY';
const FALLBACK_DIALECT = 'ANSI_SQL';
// The logical-layer schema version this loader was written against; a document
// declaring a different version is loaded anyway, with a warning.
const SUPPORTED_VERSION = '0.2.0.dev0';


// An expression is supplied as one or more per-dialect variants; we collapse it
// to at most two forms (target/canonical + imported) by picking dialects.
// Unknown sibling keys are ignored.
const expressionSchema = z.object({
  dialects: z.array(z.object({
    dialect: z.string(),
    expression: z.string(),
  })).min(1),
});

// The format's AI-first annotation. It appears at every level (model, dataset,
// field, relationship, metric) and is either a bare instructions string or a
// structured object. `examples` shapes vary across producers, so it is accepted
// leniently and only string examples are carried into the IR description.
const aiContextSchema = z.union([
  z.string(),
  z.object({
    instructions: z.string().optional(),
    synonyms: z.array(z.string()).optional(),
    examples: z.array(z.any()).optional(),
  }),
]);

// A vendor-scoped extension block: opaque `data` (a JSON string) tagged by
// `vendor_name`. The spec allows these at every level (model, dataset, field,
// relationship, metric). All are preserved verbatim on the IR (see
// toCustomExtensions) for lossless round-trip; no vendor block is interpreted at
// load time -- typed views (e.g. off the GOOGLE block) are a consumer concern.
const customExtensionSchema = z.object({
  vendor_name: z.string(),
  data: z.string(),
});

// A field's dimension metadata; only the time flag is read today.
const dimensionSchema = z.object({
  is_time: z.boolean().optional(),
});

const fieldSchema = z.object({
  name: z.string(),
  expression: expressionSchema,
  datatype: z.enum(DATA_TYPES).optional(),   // closed, case-sensitive vocabulary; see DATA_TYPES
  description: z.string().optional(),
  label: z.string().optional(),
  dimension: dimensionSchema.optional(),
  ai_context: aiContextSchema.optional(),
  custom_extensions: z.array(customExtensionSchema).optional(),
});

const datasetSchema = z.object({
  name: z.string(),
  source: z.string(),
  primary_key: z.array(z.string()).optional(),
  unique_keys: z.array(z.array(z.string())).optional(),
  description: z.string().optional(),
  ai_context: aiContextSchema.optional(),
  fields: z.array(fieldSchema).optional(),
  custom_extensions: z.array(customExtensionSchema).optional(),
});

const relationshipSchema = z.object({
  name: z.string(),
  from: z.string(),
  to: z.string(),
  from_columns: z.array(z.string()).min(1),
  to_columns: z.array(z.string()).min(1),
  description: z.string().optional(),
  ai_context: aiContextSchema.optional(),
  custom_extensions: z.array(customExtensionSchema).optional(),
});

const metricSchema = z.object({
  name: z.string(),
  expression: expressionSchema,
  datatype: z.enum(DATA_TYPES).optional(),   // closed, case-sensitive vocabulary; see DATA_TYPES
  description: z.string().optional(),
  ai_context: aiContextSchema.optional(),
  custom_extensions: z.array(customExtensionSchema).optional(),
});

const modelSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  ai_context: aiContextSchema.optional(),
  custom_extensions: z.array(customExtensionSchema).optional(),
  datasets: z.array(datasetSchema).min(1),
  relationships: z.array(relationshipSchema).optional(),
  metrics: z.array(metricSchema).optional(),
});

const documentSchema = z.object({
  version: z.string().optional(),
  semantic_model: z.array(modelSchema).min(1),
});

type ExpressionDoc = z.infer<typeof expressionSchema>;
type DatasetDoc = z.infer<typeof datasetSchema>;
type FieldDoc = z.infer<typeof fieldSchema>;
type RelationshipDoc = z.infer<typeof relationshipSchema>;
type MetricDoc = z.infer<typeof metricSchema>;
type ModelDoc = z.infer<typeof modelSchema>;
type CustomExtensionDoc = z.infer<typeof customExtensionSchema>;
type AiContextDoc = z.infer<typeof aiContextSchema>;

// The AI-first `ai_context` normalized to the IR's common shape: a bare string
// is read as `instructions`; a structured object keeps its parts. `examples` is
// filtered to strings (producers vary; non-string examples are dropped).
function normalizeAiContext(ai: AiContextDoc | undefined): AiContext {
  if (ai === undefined) return {};
  if (typeof ai === 'string') return { instructions: ai };
  const out: AiContext = {};
  if (ai.instructions) out.instructions = ai.instructions;
  if (ai.synonyms && ai.synonyms.length) out.synonyms = [...new Set(ai.synonyms)];
  if (ai.examples && ai.examples.length) {
    const strings = ai.examples.filter((e): e is string => typeof e === 'string');
    if (strings.length) out.examples = strings;
  }
  return out;
}

// Normalizes `ai_context` and returns it only when it carries something, so the
// IR omits empty aiContext objects.
function aiContextOrUndefined(ai: AiContextDoc | undefined): AiContext | undefined {
  const ctx = normalizeAiContext(ai);
  return (ctx.instructions || ctx.synonyms || ctx.examples) ? ctx : undefined;
}

// Preserves vendor `custom_extensions` verbatim on the IR (`vendor_name` ->
// `vendorName`; `data` kept as the opaque, vendor-serialized string) so nothing
// is lost and a 1P round-trip stays lossless. Typed views over specific vendors
// are derived by the consumers that need them, not here.
function toCustomExtensions(
    exts: CustomExtensionDoc[] | undefined): CustomExtension[] | undefined {
  if (!exts || !exts.length) return undefined;
  return exts.map(e => ({ vendorName: e.vendor_name, data: e.data }));
}

// Composes a single description string from ordered parts, dropping empties.
// Parts are separated by blank lines so a base description and derived markers
// read as distinct paragraphs in the emitted metadata. AI-first annotations
// (instructions / synonyms / examples) are NOT folded in here — they are carried
// structurally on the IR (aiContext) so an emitter can route them to their own
// aspects.
function composeDescription(...parts: (string | undefined)[]): string | undefined {
  const kept = parts
    .map(p => (p === undefined ? undefined : p.trim()))
    .filter((p): p is string => !!p);
  return kept.length ? kept.join('\n\n') : undefined;
}


/**
 * Loads YAML or JSON text (a document in the AI-first semantics format) into the
 * Semantic Model IR. `yaml.parse` accepts JSON too, so both are supported.
 */
export function loadModels(text: string, opts: LoadOptions = {}): LoadResult {
  let doc: unknown;
  try {
    doc = yaml.parse(text);
  } catch (err: any) {
    throw new Error(`Semantic model load error: could not parse input: ${err?.message ?? err}`);
  }
  return fromDocument(doc, opts);
}

/**
 * Converts an already-parsed document object into the Semantic Model IR. Throws
 * on a structurally invalid document; softer, lossy conversions are reported in
 * `warnings` rather than thrown.
 */
export function fromDocument(doc: unknown, opts: LoadOptions = {}): LoadResult {
  const result = documentSchema.safeParse(doc);
  if (!result.success) {
    throw new Error(`Semantic model load error: ${result.error.message}`);
  }

  const warnings: string[] = [];
  const parsed = result.data;

  if (parsed.version && parsed.version !== SUPPORTED_VERSION) {
    warnings.push(
      `document version '${parsed.version}' differs from the supported '${SUPPORTED_VERSION}'; ` +
      `loading anyway`);
  }

  const models = parsed.semantic_model.map(m => convertModel(m, opts, warnings));
  return { models, warnings: [...new Set(warnings)] };
}


// Flags names that appear more than once within a scope. Uniqueness is required
// for a valid graph: a duplicate dataset, field, metric, or relationship name
// makes the generated nodes, properties, or edges ambiguous. Reported as
// warnings (the loader stays lenient and never rejects a valid document); a
// strict `validate` gate can promote these to errors later.
function warnDuplicateNames(
    names: string[], kind: string, scope: string, warnings: string[]): void {
  const seen = new Set<string>();
  for (const n of names) {
    if (seen.has(n)) {
      warnings.push(
        `${scope}: duplicate ${kind} '${n}'; names must be unique ` +
        `(the generated graph will be invalid)`);
    }
    seen.add(n);
  }
}

function convertModel(m: ModelDoc, opts: LoadOptions, warnings: string[]): SemanticModel {
  const dialect = opts.dialect ?? DEFAULT_DIALECT;

  const entities = m.datasets.map(ds => convertDataset(ds, opts, warnings, dialect));
  warnDuplicateNames(entities.map(e => e.name), 'dataset name', `model '${m.name}'`, warnings);

  const entityNames = entities.map(e => e.name);
  const entityNameSet = new Set(entityNames);

  const relationships = (m.relationships ?? []).map(
    r => convertRelationship(r, entityNameSet));
  warnDuplicateNames(
    relationships.map(r => r.name), 'relationship name', `model '${m.name}'`, warnings);

  const metrics = (m.metrics ?? []).map(
    mt => convertMetric(mt, entityNames, warnings, dialect));
  warnDuplicateNames(metrics.map(mt => mt.name), 'metric name', `model '${m.name}'`, warnings);

  const description = composeDescription(m.description);

  const model: SemanticModel = { name: m.name, entities, relationships, metrics };
  if (description) model.description = description;
  const ai = aiContextOrUndefined(m.ai_context);
  if (ai) model.aiContext = ai;
  const ce = toCustomExtensions(m.custom_extensions);
  if (ce) model.customExtensions = ce;
  return model;
}

function convertDataset(ds: DatasetDoc, opts: LoadOptions,
                        warnings: string[], dialect: string): Entity {
  const ctxLabel = `dataset '${ds.name}'`;
  const dataSource = parseSource(ds.source, opts, warnings, ctxLabel);
  const keys = ds.primary_key ?? [];
  if (!keys.length) {
    warnings.push(`${ctxLabel}: no primary_key; the entity's KEY will be empty (invalid for graph generation)`);
  }
  const fields = (ds.fields ?? []).map(f => convertField(f, ds.name, warnings, dialect));
  warnDuplicateNames(fields.map(f => f.name), 'field name', `dataset '${ds.name}'`, warnings);

  const entity: Entity = { name: ds.name, dataSource, keys, fields };
  if (ds.unique_keys && ds.unique_keys.length) entity.uniqueKeys = ds.unique_keys;
  const description = composeDescription(ds.description);
  if (description) entity.description = description;
  const ai = aiContextOrUndefined(ds.ai_context);
  if (ai) entity.aiContext = ai;
  const ce = toCustomExtensions(ds.custom_extensions);
  if (ce) entity.customExtensions = ce;
  return entity;
}

function convertField(f: FieldDoc, entityName: string, warnings: string[], dialect: string): Field {
  const picked = pickDialect(f.expression, dialect, `field '${entityName}.${f.name}'`, warnings);

  // `label`, `dimension`, and AI-first annotations are carried structurally on
  // the IR (not folded into `description`) so an emitter can route each to its
  // own destination and a 1P round-trip stays lossless.
  const description = composeDescription(f.description);

  const field: Field = { name: f.name };
  if (picked.expression !== undefined) field.expression = picked.expression;
  if (picked.importedExpression !== undefined) {
    field.importedExpression = picked.importedExpression;
    field.importedDialect = picked.importedDialect;
  }
  if (f.datatype) field.type = f.datatype;
  if (f.label) field.label = f.label;
  if (f.dimension) {
    field.dimension = {};
    if (f.dimension.is_time !== undefined) field.dimension.isTime = f.dimension.is_time;
  }
  if (description) field.description = description;
  const ai = aiContextOrUndefined(f.ai_context);
  if (ai) field.aiContext = ai;
  const ce = toCustomExtensions(f.custom_extensions);
  if (ce) field.customExtensions = ce;
  return field;
}

// Maps an OSI foreign-key relationship onto the IR edge. `source.columns` are the
// FK columns on the `from` table (`from_columns`); `destination.columns` are the
// referenced key columns on the `to` table (`to_columns`), paired positionally.
// The source entity's own primary key is not duplicated here -- downstream
// consumers look it up from the entity. A malformed relationship (an endpoint not
// declared in the model, or mismatched column arity) is a hard error, not a
// warning: the resulting edge would be structurally invalid.
function convertRelationship(r: RelationshipDoc, entityNames: Set<string>): Relationship {
  const ctx = `relationship '${r.name}'`;
  if (!entityNames.has(r.from)) {
    throw new Error(`${ctx}: 'from' dataset '${r.from}' is not defined in the model`);
  }
  if (!entityNames.has(r.to)) {
    throw new Error(`${ctx}: 'to' dataset '${r.to}' is not defined in the model`);
  }
  if (r.from_columns.length !== r.to_columns.length) {
    throw new Error(
      `${ctx}: from_columns (${r.from_columns.length}) and to_columns ` +
      `(${r.to_columns.length}) have different lengths; the join keys are mismatched`);
  }

  const relationship: Relationship = {
    name: r.name,
    source: { entity: r.from, columns: r.from_columns },
    destination: { entity: r.to, columns: r.to_columns },
  };
  const description = composeDescription(r.description);
  if (description) relationship.description = description;
  const ai = aiContextOrUndefined(r.ai_context);
  if (ai) relationship.aiContext = ai;
  const ce = toCustomExtensions(r.custom_extensions);
  if (ce) relationship.customExtensions = ce;
  return relationship;
}

function convertMetric(mt: MetricDoc, entityNames: string[],
                       warnings: string[], dialect: string): Metric {
  const ctx = `metric '${mt.name}'`;
  const picked = pickDialect(mt.expression, dialect, ctx, warnings);
  // Infer referenced entities from whichever expression form we have; the
  // imported form still carries the same entity qualifiers.
  const exprForRefs = picked.expression ?? picked.importedExpression ?? '';
  const referenced = referencedEntityNames(exprForRefs, entityNames);
  if (!referenced.length) {
    warnings.push(`${ctx}: expression references no known entity; it may not be placeable downstream`);
  }
  const metric: Metric = { name: mt.name };
  // Attach only when the reference is unambiguous; a cross-entity metric is left
  // unattached (its qualifiers stay inline in the expression for consumers).
  if (referenced.length === 1) metric.entity = referenced[0];
  if (picked.expression !== undefined) metric.expression = picked.expression;
  if (picked.importedExpression !== undefined) {
    metric.importedExpression = picked.importedExpression;
    metric.importedDialect = picked.importedDialect;
  }
  if (mt.datatype) metric.type = mt.datatype;
  const description = composeDescription(mt.description);
  if (description) metric.description = description;
  const ai = aiContextOrUndefined(mt.ai_context);
  if (ai) metric.aiContext = ai;
  const ce = toCustomExtensions(mt.custom_extensions);
  if (ce) metric.customExtensions = ce;
  return metric;
}

// Collapses an expression's per-dialect variants into at most two forms:
//   - `expression`: a target/canonical form valid against the target. Preference
//     is the requested dialect, else the portable canonical dialect (ANSI_SQL).
//   - `importedExpression` (+ `importedDialect`): the original vendor SQL, kept
//     verbatim so nothing is lost and a later transpile pass (see ./transpile)
//     can fill `expression` from it.
// Dialect names are compared case-insensitively. No transpilation is performed
// here; chosen expressions are passed through verbatim. At least one form is set.
//
// The fallbacks differ in risk, so they are surfaced differently:
//   - ANSI_SQL is the AI-first format's default expression language (ANSI
//     SQL:2003 core), deliberately chosen to be valid across targets — BigQuery
//     included. Using it as `expression` is the intended authoring path, not a
//     lossy degradation, so it is reported as a single informational `note:`
//     (worded field-agnostically so identical notes dedupe to one line).
//   - When neither the target nor ANSI_SQL is present, `expression` is left
//     unset and only `importedExpression` is populated; that is a genuine risk
//     (needs transpilation) and is warned per field/metric, naming the dialect.
interface PickedExpression {
  expression?: string;
  importedExpression?: string;
  importedDialect?: string;
}

function pickDialect(expr: ExpressionDoc, preferred: string,
                     ctx: string, warnings: string[]): PickedExpression {
  const upper = (s: string) => s.toUpperCase();
  const byName = (name: string) =>
    expr.dialects.find(d => upper(d.dialect) === upper(name));

  // The original vendor variant, if any: the first dialect that is neither the
  // target nor the portable canonical. Kept as `importedExpression`.
  const vendor = expr.dialects.find(
    d => upper(d.dialect) !== upper(preferred) && upper(d.dialect) !== FALLBACK_DIALECT);

  const out: PickedExpression = {};
  if (vendor) {
    out.importedExpression = vendor.expression;
    out.importedDialect = vendor.dialect;
  }

  const exact = byName(preferred);
  if (exact) {
    out.expression = exact.expression;
    return out;
  }

  const canonical = byName(FALLBACK_DIALECT);
  if (canonical) {
    out.expression = canonical.expression;
    warnings.push(
      `note: no '${preferred}' dialect for one or more expressions; using the portable ` +
      `'${FALLBACK_DIALECT}' dialect verbatim ('${preferred}' accepts the ANSI core subset — ` +
      `supply '${preferred}' variants only for ${preferred}-specific SQL)`);
    return out;
  }

  // Neither target nor canonical: keep only the imported vendor form; the
  // target `expression` awaits a transpile pass.
  warnings.push(
    `${ctx}: no '${preferred}' or '${FALLBACK_DIALECT}' dialect; keeping the ` +
    `'${out.importedDialect}' expression as imported_expression (needs transpilation to '${preferred}')`);
  return out;
}

// Normalizes a dotted `source` string into a canonical, fully-qualified
// reference. Each identifier segment is unquoted, and a short reference has its
// leading qualifiers prepended from options (a bare `table` gets both defaults;
// a `dataset.table` gets the project). References that already carry three or
// more segments are passed through untouched, so an already-qualified name keeps
// whatever shape the source system gave it rather than being forced into fixed
// slots. A source that looks like a query (contains whitespace) cannot be
// qualified, so it is kept verbatim.
function parseSource(source: string, opts: LoadOptions,
                     warnings: string[], ctx: string): string {
  const trimmed = source.trim();

  if (/\s/.test(trimmed)) {
    warnings.push(`${ctx}: source looks like a query, not a table reference; keeping it verbatim`);
    return trimmed;
  }

  const parts = trimmed.split('.').map(unquote);
  if (parts.length === 1 && opts.defaultDataset) parts.unshift(opts.defaultDataset);
  if (parts.length < 3 && opts.defaultProject) parts.unshift(opts.defaultProject);
  return parts.join('.');
}

function unquote(part: string): string {
  return part.replace(/^[`"]/, '').replace(/[`"]$/, '');
}
