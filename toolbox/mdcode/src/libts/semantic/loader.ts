// Loads an open, vendor-neutral AI-first semantics format (YAML/JSON) into the
// Semantic Model IR (./ir).
//
// The format describes a semantic model as datasets (entities), foreign-key
// relationships, and model-level metrics, with entity-qualified SQL expressions
// (`Entity.column`) supplied per SQL dialect. This module reads the subset of
// that logical layer needed to normalize a model into the IR, so the rest of
// the toolbox (e.g. the BigQuery property-graph generator) can consume models
// authored in it. Fields outside the supported subset are accepted and ignored.
//

import * as yaml from 'yaml';
import * as z from 'zod';

import {AiContext, CustomExtension, DATA_TYPES, Entity, Field, Metric, Relationship, SemanticModel,} from './ir';
import {referencedEntityNames} from './sql_expr_utils';

export interface LoadOptions {
  dialect?: string;  // preferred expression dialect; default 'BIGQUERY'
  defaultProject?:
      string;  // fallback when a dataset `source` omits the project
  defaultDataset?:
      string;  // fallback when a dataset `source` omits the dataset
  // Accept a purely logical model: do not require a `source` on each concrete
  // dataset or an `expression` on each field. Set for a Knowledge-Catalog-only
  // push, which governs the logical model (meaning) and needs no physical
  // binding. Graph legs (BigQuery/Spanner) never set it -- they cannot generate
  // a graph without bindings. Contradiction checks (unbound+expression,
  // abstract+source) stay enforced regardless.
  bindingOptional?: boolean;
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
//
// A one-line string is accepted as shorthand for a single target-dialect
// variant (`expression: c_name` == `{dialects: [{dialect: BIGQUERY, expression:
// c_name}]}`) and normalized to the object form here, so the rest of the loader
// only ever sees the per-dialect object.
const expressionObjectSchema = z.object({
  dialects: z.array(z.object({
               dialect: z.string(),
               expression: z.string(),
             })).min(1),
});
const expressionSchema = z.union([
  z.string().transform((s): z.infer<typeof expressionObjectSchema> => ({
                         dialects: [{dialect: DEFAULT_DIALECT, expression: s}],
                       })),
  expressionObjectSchema,
]);

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
// toCustomExtensions) for lossless round-trip; no vendor block is interpreted
// at load time -- typed views (e.g. off the GOOGLE block) are a consumer
// concern.
const customExtensionSchema = z.object({
  vendor_name: z.string(),
  data: z.string(),
});

// A field's dimension metadata; only the time flag is read today.
const dimensionSchema = z.object({
  is_time: z.boolean().optional(),
});

// The field object shape, WITHOUT the binding-completeness refinement. The
// refinement is applied per-load by makeDocumentSchema, so a
// Knowledge-Catalog-only push (bindingOptional) can accept a purely logical
// field. A superRefine does not change a schema's inferred type, so FieldDoc is
// inferred from this base.
const fieldBase = z.object({
  name: z.string(),
  // A bound field names its physical column via `expression`; an `unbound`
  // field has no column under this binding. Whether a field must be bound (or
  // explicitly `unbound`) is decided per-load by makeDocumentSchema; a purely
  // logical field carries neither.
  expression: expressionSchema.optional(),
  unbound: z.boolean().optional(),
  datatype: z.enum(DATA_TYPES).optional(),  // closed, case-sensitive
                                            // vocabulary; see DATA_TYPES
  description: z.string().optional(),
  label: z.string().optional(),
  dimension: dimensionSchema.optional(),
  ai_context: aiContextSchema.optional(),
  custom_extensions: z.array(customExtensionSchema).optional(),
});

// The dataset object shape, WITHOUT the source-required refinement (applied
// per-load by makeDocumentSchema). DatasetDoc is inferred from this base.
const datasetBase = z.object({
  name: z.string(),
  // A concrete dataset is backed by a physical `source` table; an `abstract`
  // one has no table. Whether a non-abstract dataset must name a `source` is
  // decided per-load by makeDocumentSchema (a KC-only push accepts a logical
  // dataset with none); the abstract+source contradiction is always rejected.
  source: z.string().optional(),
  primary_key: z.array(z.string()).optional(),
  unique_keys: z.array(z.array(z.string())).optional(),
  // Supertype entity names (Ossie `extends`) -- entity-level inheritance. Only
  // datasets carry it; relationships have no `extends`.
  extends: z.array(z.string()).optional(),
  // Marks a conceptual entity with no physical table (see Entity.abstract): it
  // forms no node table and survives only as a label on its concrete
  // descendants. Distinct from an unbound `source` placeholder, which must fail
  // loudly rather than be silently treated as table-less.
  abstract: z.boolean().optional(),
  description: z.string().optional(),
  ai_context: aiContextSchema.optional(),
  fields: z.array(fieldBase).optional(),
  custom_extensions: z.array(customExtensionSchema).optional(),
});

const relationshipSchema = z.object({
                              name: z.string(),
                              from: z.string(),
                              to: z.string(),
                              // Join columns are the physical binding of the
                              // edge and are OPTIONAL, so a purely logical
                              // relationship (an ontology edge, direction only)
                              // loads. When present they must be non-empty;
                              // either both endpoints are bound or neither is
                              // (a half-bound edge is a malformed join, caught
                              // below). A graph push still requires both (see
                              // validatePushRequirements).
                              from_columns:
                                  z.array(z.string()).min(1).optional(),
                              to_columns: z.array(z.string()).min(1).optional(),
                              description: z.string().optional(),
                              ai_context: aiContextSchema.optional(),
                              custom_extensions:
                                  z.array(customExtensionSchema).optional(),
                            }).superRefine((r, ctx) => {
  if ((r.from_columns === undefined) !== (r.to_columns === undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `relationship '${
                   r.name}': from_columns and to_columns must be given ` +
          `together (both bind the edge) or both omitted (a logical edge); one ` +
          `without the other is a half-bound join.`,
    });
  }
});

const metricSchema = z.object({
  name: z.string(),
  expression: expressionSchema,
  datatype: z.enum(DATA_TYPES).optional(),  // closed, case-sensitive
                                            // vocabulary; see DATA_TYPES
  description: z.string().optional(),
  ai_context: aiContextSchema.optional(),
  custom_extensions: z.array(customExtensionSchema).optional(),
});

const modelBase = z.object({
  name: z.string(),
  description: z.string().optional(),
  ai_context: aiContextSchema.optional(),
  custom_extensions: z.array(customExtensionSchema).optional(),
  datasets: z.array(datasetBase).min(1),
  relationships: z.array(relationshipSchema).optional(),
  metrics: z.array(metricSchema).optional(),
});

// Builds the document schema with the binding-completeness refinement applied
// according to `bindingOptional`. When false (the default -- any push that
// includes a graph leg), each concrete dataset must name a `source` and each
// field must be bound or explicitly `unbound`. When true (a
// Knowledge-Catalog-only push, which governs the logical model), those two
// requirements are dropped so a purely logical model loads. The contradiction
// checks (unbound+expression, abstract+source) are enforced either way.
function buildDocumentSchema(bindingOptional: boolean) {
  const field = fieldBase.superRefine((f, ctx) => {
    if (f.unbound && f.expression !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expression'],
        message: `field '${f.name}': an unbound field has no column; remove ` +
            `'expression', or drop 'unbound: true' to bind it to that column`,
      });
    }
    // The "requires an expression" check lives at the dataset level below, not
    // here: a field on an ABSTRACT dataset legitimately has no column (the
    // supertype has no table -- it survives only as a label on its subtypes),
    // and only the dataset's superRefine can see `abstract`.
  });
  const dataset =
      datasetBase.extend({fields: z.array(field).optional()})
          .superRefine((ds, ctx) => {
            // A concrete (non-abstract) dataset must name its backing table;
            // only an abstract one may omit `source`. Relaxed under
            // bindingOptional, where a logical dataset has no source.
            if (!bindingOptional && !ds.abstract && ds.source === undefined) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['source'],
                message:
                    `dataset '${ds.name}': a non-abstract dataset requires a ` +
                    `source; set 'source', or mark it 'abstract: true' if it has no table`,
              });
            }
            // The converse is always contradictory: an abstract dataset has no
            // physical table, so a `source` on it would be silently ignored by
            // the BigQuery leg. Reject it regardless of bindingOptional.
            if (ds.abstract && ds.source !== undefined) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['source'],
                message:
                    `dataset '${ds.name}': an abstract dataset has no table; ` +
                    `remove 'source', or drop 'abstract: true' to bind it to that table`,
              });
            }
            // Under a graph leg, every field of a CONCRETE dataset must be
            // bound or explicitly unbound. An abstract dataset is exempt: it
            // has no table, so its fields carry no column -- they define the
            // label signature its subtypes bind. Enforced here (not on the
            // field) so `abstract` is visible.
            if (!bindingOptional && !ds.abstract) {
              (ds.fields ?? []).forEach((f, i) => {
                if (!f.unbound && f.expression === undefined) {
                  ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['fields', i, 'expression'],
                    message: `field '${f.name}': requires an expression; set ` +
                        `'expression', or mark it 'unbound: true' if this ` +
                        `binding has no column for it`,
                  });
                }
              });
            }
          });
  const model = modelBase.extend({datasets: z.array(dataset).min(1)});
  return z.object({
    version: z.string().optional(),
    semantic_model: z.array(model).min(1),
  });
}

// Only two schema shapes exist (strict vs binding-optional) and each is
// immutable, so build both once at module load and select between them rather
// than reconstructing the whole field/dataset/model/document graph -- with
// fresh superRefine closures -- on every fromDocument call.
const strictDocumentSchema = buildDocumentSchema(false);
const logicalDocumentSchema = buildDocumentSchema(true);
function makeDocumentSchema(bindingOptional: boolean) {
  return bindingOptional ? logicalDocumentSchema : strictDocumentSchema;
}

type ExpressionDoc = z.infer<typeof expressionSchema>;
type DatasetDoc = z.infer<typeof datasetBase>;
type FieldDoc = z.infer<typeof fieldBase>;
type RelationshipDoc = z.infer<typeof relationshipSchema>;
type MetricDoc = z.infer<typeof metricSchema>;
type ModelDoc = z.infer<typeof modelBase>;
type CustomExtensionDoc = z.infer<typeof customExtensionSchema>;
type AiContextDoc = z.infer<typeof aiContextSchema>;

// The AI-first `ai_context` normalized to the IR's common shape: a bare string
// is read as `instructions`; a structured object keeps its parts. `examples` is
// filtered to strings (producers vary; non-string examples are dropped).
function normalizeAiContext(ai: AiContextDoc|undefined): AiContext {
  if (ai === undefined) return {};
  if (typeof ai === 'string') return {instructions: ai};
  const out: AiContext = {};
  if (ai.instructions) out.instructions = ai.instructions;
  if (ai.synonyms && ai.synonyms.length)
    out.synonyms = [...new Set(ai.synonyms)];
  if (ai.examples && ai.examples.length) {
    const strings =
        ai.examples.filter((e): e is string => typeof e === 'string');
    if (strings.length) out.examples = strings;
  }
  return out;
}

// Normalizes `ai_context` and returns it only when it carries something, so the
// IR omits empty aiContext objects.
function aiContextOrUndefined(ai: AiContextDoc|undefined): AiContext|undefined {
  const ctx = normalizeAiContext(ai);
  return (ctx.instructions || ctx.synonyms || ctx.examples) ? ctx : undefined;
}

// Preserves vendor `custom_extensions` verbatim on the IR (`vendor_name` ->
// `vendorName`; `data` kept as the opaque, vendor-serialized string) so nothing
// is lost and a 1P round-trip stays lossless. Typed views over specific vendors
// are derived by the consumers that need them, not here.
function toCustomExtensions(exts: CustomExtensionDoc[]|undefined):
    CustomExtension[]|undefined {
  if (!exts || !exts.length) return undefined;
  return exts.map(e => ({vendorName: e.vendor_name, data: e.data}));
}

// Composes a single description string from ordered parts, dropping empties.
// Parts are separated by blank lines so a base description and derived markers
// read as distinct paragraphs in the emitted metadata. AI-first annotations
// (instructions / synonyms / examples) are NOT folded in here — they are
// carried structurally on the IR (aiContext) so an emitter can route them to
// their own aspects.
function composeDescription(...parts: (string|undefined)[]): string|undefined {
  const kept = parts.map(p => (p === undefined ? undefined : p.trim()))
                   .filter((p): p is string => !!p);
  return kept.length ? kept.join('\n\n') : undefined;
}


// The vendor tag for Google-specific extension blocks (kept in sync with the
// deploy leg's reader). A model-level `deployment_target:` folds into one.
const GOOGLE_VENDOR = 'GOOGLE';

// Rewrites the author-friendly sugar forms into the canonical wire shape the
// schema validates, so the guide's readable syntax and the underlying format
// are one code path: `entities:` is an alias for `datasets:`, and a model-level
// `deployment_target:` URI folds into a GOOGLE `custom_extensions` block (the
// form the deploy leg reads). Conflicts -- both `entities` and `datasets`, or a
// `deployment_target` that disagrees with an existing GOOGLE block -- are load
// errors, named here. Operates on the parsed document before schema validation.
function normalizeDocumentSugars(doc: unknown): unknown {
  if (!doc || typeof doc !== 'object') return doc;
  const cloned = structuredClone(doc) as any;
  const models = cloned.semantic_model;
  if (!Array.isArray(models)) return cloned;
  for (const m of models) {
    if (m && typeof m === 'object') normalizeModelSugars(m);
  }
  return cloned;
}

function normalizeModelSugars(m: any): void {
  const label = typeof m.name === 'string' ? `model '${m.name}'` : 'model';

  if (m.entities !== undefined) {
    if (m.datasets !== undefined) {
      throw new Error(
          `Semantic model load error: ${label}: set either ` +
          `'entities' or 'datasets', not both (they are the same key).`);
    }
    m.datasets = m.entities;
    delete m.entities;
  }

  if (m.deployment_target !== undefined) {
    const target = m.deployment_target;
    if (typeof target !== 'string') {
      throw new Error(
          `Semantic model load error: ${label}: ` +
          `'deployment_target' must be a URI string.`);
    }
    foldDeploymentTarget(m, target, label);
    delete m.deployment_target;
  }
}

// Merges a `deployment_target` URI into the model's GOOGLE custom_extensions.
// If a GOOGLE block already declares deploymentTargets, the URI must be among
// them (the two forms mean the same thing and must agree); otherwise a fresh
// GOOGLE block is appended.
function foldDeploymentTarget(m: any, target: string, label: string): void {
  const exts = Array.isArray(m.custom_extensions) ? m.custom_extensions : [];
  for (const ext of exts) {
    if (!ext || ext.vendor_name !== GOOGLE_VENDOR ||
        typeof ext.data !== 'string') {
      continue;
    }
    let data: any;
    try {
      data = JSON.parse(ext.data);
    } catch {
      continue;  // a malformed block is the deploy leg's error to report
    }
    const list = data?.deploymentTargets;
    if (Array.isArray(list) && list.length) {
      if (!list.includes(target)) {
        throw new Error(
            `Semantic model load error: ${label}: ` +
            `'deployment_target' disagrees with the GOOGLE custom_extension ` +
            `already on this model; set one, or make them match.`);
      }
      return;  // agree: nothing to add
    }
  }
  exts.push({
    vendor_name: GOOGLE_VENDOR,
    data: JSON.stringify({deploymentTargets: [target]}),
  });
  m.custom_extensions = exts;
}

/**
 * Loads YAML or JSON text (a document in the AI-first semantics format) into
 * the Semantic Model IR. `yaml.parse` accepts JSON too, so both are supported.
 */
export function loadModels(text: string, opts: LoadOptions = {}): LoadResult {
  let doc: unknown;
  try {
    doc = yaml.parse(text);
  } catch (err: any) {
    throw new Error(`Semantic model load error: could not parse input: ${
        err?.message ?? err}`);
  }
  return fromDocument(doc, opts);
}

/**
 * Converts an already-parsed document object into the Semantic Model IR. Throws
 * on a structurally invalid document; softer, lossy conversions are reported in
 * `warnings` rather than thrown.
 */
export function fromDocument(doc: unknown, opts: LoadOptions = {}): LoadResult {
  const normalized = normalizeDocumentSugars(doc);
  const result =
      makeDocumentSchema(opts.bindingOptional ?? false).safeParse(normalized);
  if (!result.success) {
    throw new Error(`Semantic model load error: ${result.error.message}`);
  }

  const warnings: string[] = [];
  const parsed = result.data;

  if (parsed.version && parsed.version !== SUPPORTED_VERSION) {
    warnings.push(
        `document version '${parsed.version}' differs from the supported '${
            SUPPORTED_VERSION}'; ` +
        `loading anyway`);
  }

  const models =
      parsed.semantic_model.map(m => convertModel(m, opts, warnings));
  return {models, warnings: [...new Set(warnings)]};
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

function convertModel(
    m: ModelDoc, opts: LoadOptions, warnings: string[]): SemanticModel {
  const dialect = opts.dialect ?? DEFAULT_DIALECT;

  const entities =
      m.datasets.map(ds => convertDataset(ds, opts, warnings, dialect));
  warnDuplicateNames(
      entities.map(e => e.name), 'dataset name', `model '${m.name}'`, warnings);

  const entityNames = entities.map(e => e.name);
  const entityNameSet = new Set(entityNames);

  const relationships =
      (m.relationships ?? []).map(r => convertRelationship(r, entityNameSet));
  warnDuplicateNames(
      relationships.map(r => r.name), 'relationship name', `model '${m.name}'`,
      warnings);

  const metrics =
      (m.metrics ??
       []).map(mt => convertMetric(mt, entityNames, warnings, dialect));
  warnDuplicateNames(
      metrics.map(mt => mt.name), 'metric name', `model '${m.name}'`, warnings);

  const description = composeDescription(m.description);

  const model: SemanticModel = {name: m.name, entities, relationships, metrics};
  if (description) model.description = description;
  const ai = aiContextOrUndefined(m.ai_context);
  if (ai) model.aiContext = ai;
  const ce = toCustomExtensions(m.custom_extensions);
  if (ce) model.customExtensions = ce;
  return model;
}

function convertDataset(
    ds: DatasetDoc, opts: LoadOptions, warnings: string[],
    dialect: string): Entity {
  const ctxLabel = `dataset '${ds.name}'`;
  // An abstract entity has no physical table, so it carries no source (empty
  // dataSource) and no key -- both are meaningless for a class never
  // materialized. Only a concrete entity is parsed/warned for those.
  const dataSource = ds.source !== undefined ?
      parseSource(ds.source, opts, warnings, ctxLabel) :
      '';
  const keys = ds.primary_key ?? [];
  if (!keys.length && !ds.abstract) {
    warnings.push(`${
        ctxLabel}: no primary_key; the entity's KEY will be empty (invalid for graph generation)`);
  }
  const fields =
      (ds.fields ?? []).map(f => convertField(f, ds.name, warnings, dialect));
  warnDuplicateNames(
      fields.map(f => f.name), 'field name', `dataset '${ds.name}'`, warnings);

  const entity: Entity = {name: ds.name, dataSource, keys, fields};
  if (ds.unique_keys && ds.unique_keys.length)
    entity.uniqueKeys = ds.unique_keys;
  if (ds.extends && ds.extends.length) entity.extends = ds.extends;
  if (ds.abstract) entity.abstract = true;
  const description = composeDescription(ds.description);
  if (description) entity.description = description;
  const ai = aiContextOrUndefined(ds.ai_context);
  if (ai) entity.aiContext = ai;
  const ce = toCustomExtensions(ds.custom_extensions);
  if (ce) entity.customExtensions = ce;
  return entity;
}

function convertField(
    f: FieldDoc, entityName: string, warnings: string[],
    dialect: string): Field {
  // `label`, `dimension`, and AI-first annotations are carried structurally on
  // the IR (not folded into `description`) so an emitter can route each to its
  // own destination and a 1P round-trip stays lossless.
  const description = composeDescription(f.description);

  const field: Field = {name: f.name};
  if (f.unbound) {
    // Declared but not bound under this binding: no column, no expression (the
    // schema guarantees `expression` is absent here). See Field.unbound.
    field.unbound = true;
  } else if (f.expression !== undefined) {
    const picked = pickDialect(
        f.expression, dialect, `field '${entityName}.${f.name}'`, warnings);
    if (picked.expression !== undefined) field.expression = picked.expression;
    if (picked.importedExpression !== undefined) {
      field.importedExpression = picked.importedExpression;
      field.importedDialect = picked.importedDialect;
    }
  }
  // else: a purely logical field (no expression, not explicitly unbound). Only
  // reachable under bindingOptional -- strict loading requires one or the other
  // -- so the field carries meaning with no physical column for a KC-only push.
  if (f.datatype) field.type = f.datatype;
  if (f.label) field.label = f.label;
  if (f.dimension) {
    field.dimension = {};
    if (f.dimension.is_time !== undefined)
      field.dimension.isTime = f.dimension.is_time;
  }
  if (description) field.description = description;
  const ai = aiContextOrUndefined(f.ai_context);
  if (ai) field.aiContext = ai;
  const ce = toCustomExtensions(f.custom_extensions);
  if (ce) field.customExtensions = ce;
  return field;
}

// Maps an OSI foreign-key relationship onto the IR edge. `source.columns` are
// the FK columns on the `from` table (`from_columns`); `destination.columns`
// are the referenced key columns on the `to` table (`to_columns`), paired
// positionally. A logical relationship carries no columns (both endpoints
// empty); a graph push requires them and rejects a column-less edge (see
// validatePushRequirements). The source entity's own primary key is not
// duplicated here -- downstream consumers look it up from the entity. A
// malformed relationship (an endpoint not declared in the model, or mismatched
// column arity) is a hard error, not a warning: the resulting edge would be
// structurally invalid.
function convertRelationship(
    r: RelationshipDoc, entityNames: Set<string>): Relationship {
  const ctx = `relationship '${r.name}'`;
  if (!entityNames.has(r.from)) {
    throw new Error(
        `${ctx}: 'from' dataset '${r.from}' is not defined in the model`);
  }
  if (!entityNames.has(r.to)) {
    throw new Error(
        `${ctx}: 'to' dataset '${r.to}' is not defined in the model`);
  }
  const fromColumns = r.from_columns ?? [];
  const toColumns = r.to_columns ?? [];
  if (fromColumns.length !== toColumns.length) {
    throw new Error(
        `${ctx}: from_columns (${fromColumns.length}) and to_columns ` +
        `(${
            toColumns
                .length}) have different lengths; the join keys are mismatched`);
  }

  const relationship: Relationship = {
    name: r.name,
    source: {entity: r.from, columns: fromColumns},
    destination: {entity: r.to, columns: toColumns},
  };
  const description = composeDescription(r.description);
  if (description) relationship.description = description;
  const ai = aiContextOrUndefined(r.ai_context);
  if (ai) relationship.aiContext = ai;
  const ce = toCustomExtensions(r.custom_extensions);
  if (ce) relationship.customExtensions = ce;
  return relationship;
}

function convertMetric(
    mt: MetricDoc, entityNames: string[], warnings: string[],
    dialect: string): Metric {
  const ctx = `metric '${mt.name}'`;
  const picked = pickDialect(mt.expression, dialect, ctx, warnings);
  // Infer referenced entities from whichever expression form we have; the
  // imported form still carries the same entity qualifiers.
  const exprForRefs = picked.expression ?? picked.importedExpression ?? '';
  const referenced = referencedEntityNames(exprForRefs, entityNames);
  if (!referenced.length) {
    warnings.push(`${
        ctx}: expression references no known entity; it may not be placeable downstream`);
  }
  const metric: Metric = {name: mt.name};
  // Attach only when the reference is unambiguous; a cross-entity metric is
  // left unattached (its qualifiers stay inline in the expression for
  // consumers).
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
//   - `expression`: a target/canonical form valid against the target.
//   Preference
//     is the requested dialect, else the portable canonical dialect (ANSI_SQL).
//   - `importedExpression` (+ `importedDialect`): the original vendor SQL, kept
//     verbatim so nothing is lost and a later transpile pass (see ./transpile)
//     can fill `expression` from it.
// Dialect names are compared case-insensitively. No transpilation is performed
// here; chosen expressions are passed through verbatim. At least one form is
// set.
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

function pickDialect(
    expr: ExpressionDoc, preferred: string, ctx: string,
    warnings: string[]): PickedExpression {
  const upper = (s: string) => s.toUpperCase();
  const byName = (name: string) =>
      expr.dialects.find(d => upper(d.dialect) === upper(name));

  // The original vendor variant, if any: the first dialect that is neither the
  // target nor the portable canonical. Kept as `importedExpression`.
  const vendor = expr.dialects.find(
      d => upper(d.dialect) !== upper(preferred) &&
          upper(d.dialect) !== FALLBACK_DIALECT);

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
        `note: no '${
            preferred}' dialect for one or more expressions; using the portable ` +
        `'${FALLBACK_DIALECT}' dialect verbatim ('${
            preferred}' accepts the ANSI core subset — ` +
        `supply '${preferred}' variants only for ${preferred}-specific SQL)`);
    return out;
  }

  // Neither target nor canonical: keep only the imported vendor form; the
  // target `expression` awaits a transpile pass.
  warnings.push(
      `${ctx}: no '${preferred}' or '${
          FALLBACK_DIALECT}' dialect; keeping the ` +
      `'${out.importedDialect}' expression as imported_expression (needs transpilation to '${
          preferred}')`);
  return out;
}

// Normalizes a dotted `source` string into a canonical, fully-qualified
// reference. Each identifier segment is unquoted, and a short reference has its
// leading qualifiers prepended from options (a bare `table` gets both defaults;
// a `dataset.table` gets the project). References that already carry three or
// more segments are passed through untouched, so an already-qualified name
// keeps whatever shape the source system gave it rather than being forced into
// fixed slots. A source that looks like a query (contains whitespace) cannot be
// qualified, so it is kept verbatim.
function parseSource(
    source: string, opts: LoadOptions, warnings: string[],
    ctx: string): string {
  const trimmed = source.trim();

  if (/\s/.test(trimmed)) {
    warnings.push(`${
        ctx}: source looks like a query, not a table reference; keeping it verbatim`);
    return trimmed;
  }

  // A BigQuery resource-name URI (AIP-122) is the readable way to name a
  // source; rewrite it to the canonical project.dataset.table the generator
  // emits.
  const bq = trimmed.match(
      /^\/\/bigquery\.googleapis\.com\/projects\/([^/]+)\/datasets\/([^/]+)\/tables\/(.+)$/);
  if (bq) return `${bq[1]}.${bq[2]}.${bq[3]}`;

  // Any other resource URI (Spanner, AlloyDB, an iceberg:// table, ...) is not
  // a BigQuery table and is not dotted-qualified; keep it verbatim. It rides
  // through to the consumer that binds it (the BigQuery path does not probe or
  // emit a non-BigQuery source).
  if (trimmed.startsWith('//') || /^[a-z][\w+.-]*:\/\//i.test(trimmed)) {
    return trimmed;
  }

  const parts = trimmed.split('.').map(unquote);
  if (parts.length === 1 && opts.defaultDataset)
    parts.unshift(opts.defaultDataset);
  if (parts.length < 3 && opts.defaultProject)
    parts.unshift(opts.defaultProject);
  return parts.join('.');
}

function unquote(part: string): string {
  return part.replace(/^[`"]/, '').replace(/[`"]$/, '');
}


// A single model parsed from one authored model file, tagged with that file's
// name so a consumer (a deploy leg) can attribute warnings and errors back to
// the file the author wrote.
export interface LoadedModel {
  // The model file this was parsed from: the `.yaml` basename the layout
  // discovered (e.g. `sales` for `sales.yaml`), not a filesystem path. Used
  // only to prefix this model's warnings/errors so they point at the author's
  // file; not part of the deployed IR.
  document: string;
  model: SemanticModel;
}

export interface LoadedModels {
  models: LoadedModel[];
  // Loader warnings across all documents, each prefixed with its document name.
  warnings: string[];
  // Set when a document failed to parse or violated the schema, naming the
  // document. `models` then holds whatever parsed before the failure; callers
  // should treat a set `error` as fatal and not deploy.
  error?: string;
}

/**
 * Loads every authored document into the IR once, so a multi-destination push
 * parses and validates each model a single time and fans the result out to each
 * deploy leg (BigQuery, Knowledge Catalog) rather than re-parsing per leg.
 *
 * A parse/schema error is returned as `error` (naming the document) rather than
 * thrown, mirroring how the deploy legs previously reported it; loader warnings
 * are prefixed with their document name.
 */
export function loadSemanticModels(
    docs: {name: string; text: string}[],
    opts: LoadOptions = {}): LoadedModels {
  const models: LoadedModel[] = [];
  const warnings: string[] = [];
  for (const doc of docs) {
    let loaded: LoadResult;
    try {
      loaded = loadModels(doc.text, opts);
    } catch (err: any) {
      return {
        models,
        warnings,
        error: `Model document '${doc.name}': ${err.message || err}`,
      };
    }
    for (const w of loaded.warnings) warnings.push(`[${doc.name}] ${w}`);
    for (const model of loaded.models) models.push({document: doc.name, model});
  }
  return {models, warnings};
}
