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

import {Action, ActionParameter, AffectedConcept, AiContext, CONCEPT_OPERATIONS, CONSTRAINT_SEVERITIES, Constraint, CustomExtension, DATA_TYPES, Entity, Executor, Field, Metric, Relationship, SemanticModel, VIOLATION_EFFECTS,} from './ir';
import {referencedEntityNames} from './sql_expr_utils';

export interface LoadOptions {
  dialect?: string;  // preferred expression dialect; default 'BIGQUERY'
  defaultProject?:
      string;  // fallback when a dataset `source` omits the project
  defaultDataset?:
      string;  // fallback when a dataset `source` omits the dataset
  // Accept a purely logical model: do not require a `source` on each concrete
  // dataset. Set for a Knowledge-Catalog-only push, which governs the logical
  // model (meaning) and needs no physical binding. Graph legs
  // (BigQuery/Spanner) never set it -- a concrete dataset with no table cannot
  // back a graph. A field's `expression` is never required either way: a field
  // with none is unbound and the availability pass prunes it. The
  // abstract+source contradiction stays enforced regardless.
  bindingOptional?: boolean;
}

export interface LoadResult {
  models: SemanticModel[];
  warnings: string[];
}

const DEFAULT_DIALECT = 'BIGQUERY';
const FALLBACK_DIALECT = 'ANSI_SQL';
// The two accepted format versions. Every document MUST declare one at the top
// level (a missing or unrecognized `version` is a load error). The value
// selects which extension surface is legal:
//   - OSSIE_VERSION: vanilla Apache Ossie. kcmd's extensions ride ONLY in
//     Ossie's `custom_extensions` carrier; the native extension keys
//     (`entities` alias, `extends`, `abstract`, `deployment_target`) are not
//     accepted.
//   - GOOGLE_VERSION: kcmd's extended profile. The native extension keys are
//     first-class; Ossie's `custom_extensions` field is not accepted (its
//     content is expressed natively instead).
// Both parse into the same IR, so a downstream leg never sees the difference.
const OSSIE_VERSION = '0.2.0.dev0';
const GOOGLE_VERSION = '0.2.0.dev0/google';
const ACCEPTED_VERSIONS = [OSSIE_VERSION, GOOGLE_VERSION];



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

// The canonical (superset) field shape, for TYPE inference only. The actual
// validation schemas are rebuilt per-load by buildDocumentSchema, which is
// strict, gates `custom_extensions` on the version, and applies the
// source-completeness refinement. A field is BOUND when it names a physical
// column via `expression`; a field with no `expression` is UNBOUND (no column
// under this binding). A field is never required to be bound -- an unbound
// field loads and the availability pass prunes it before generation.
const fieldBase = z.object({
  name: z.string(),
  expression: expressionSchema.optional(),
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

// An action executor: exactly one kind. The open format expresses it as an
// object with a single kind key (mcp/rest/grpc/sql); we accept the union and
// enforce the "exactly one" rule in a refinement so the message names the
// violation.
//
// `sql` carries the write itself rather than a pointer to whoever performs it,
// so the schema only checks its shape here. What makes it safe -- one DML verb
// per statement, and every `@parameter` declared by the action -- is checked in
// validate.ts, where the action's parameter list is in scope. See SqlExecutor.
const EXECUTOR_KINDS = ['mcp', 'rest', 'grpc', 'sql'] as const;

const executorSchema =
    z.object({
       mcp: z.object({server: z.string(), tool: z.string()}).strict().optional(),
       rest: z.object({endpoint: z.string(), method: z.string()})
                 .strict()
                 .optional(),
       grpc: z.object({service: z.string(), method: z.string()})
                 .strict()
                 .optional(),
       sql: z.object({statements: z.array(z.string()).min(1)})
                .strict()
                .optional(),
     })
        .strict()
        .superRefine((ex, ctx) => {
          const kinds = EXECUTOR_KINDS.filter(k => ex[k] !== undefined);
          if (kinds.length !== 1) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: kinds.length === 0 ?
                  `executor requires exactly one kind (${
                      EXECUTOR_KINDS.join(', ')}); none given` :
                  `executor requires exactly one kind, but ${kinds.length} given ` +
                      `(${kinds.join(', ')})`,
            });
          }
        });

// An action parameter: a name and an ontology type (an entity name for an object
// reference, or a scalar DataType). The type is validated against the model in
// convertAction, not here, so the schema stays a plain string.
const parameterSchema = z.object({
  name: z.string(),
  type: z.string(),
});

// One thing an action changes. Two authored shapes: a bare name, which is the
// coarse blast radius (`affects: [Order, OrderedAs]`), or a record naming the
// `concept` plus how it is changed. One key covers an entity and a
// relationship alike, because the same three operations apply to either. The
// bare name is not a lesser form -- it is the same entry with the operation
// left unspecified -- so the two mix freely in one list.
//
// The name is resolved against the model in toAffectedConcept, not here, for
// the same reason a parameter type is: the schema sees one action, and only
// the model knows what `Order` is.
const affectedConceptSchema = z.union([
  z.string(),
  z.object({
     concept: z.string(),
     operation: z.enum(CONCEPT_OPERATIONS).optional(),
     fields: z.array(z.string()).optional(),
   }).strict(),
]);

const actionSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  // Optional because it is a physical binding: a profile may supply it, and a
  // purely logical model declares actions it cannot perform. See Action.
  // `null` reads the same as absent, so `executor:` with the body commented out
  // means here what `executor: null` means in a profile: performed by nothing.
  executor: executorSchema.nullish(),
  parameters: z.array(parameterSchema).optional(),
  // Names of the constraints that gate this action. Kept as plain strings: they
  // are resolved against the model's own constraints in validate.ts, which sees
  // the whole model, whereas the schema sees one action.
  guards: z.array(z.string()).optional(),
  // What the call changes. See affectedConceptSchema.
  affects: z.array(affectedConceptSchema).optional(),
  ai_context: aiContextSchema.optional(),
  custom_extensions: z.array(customExtensionSchema).optional(),
});

// A constraint: a named invariant over the ontology, in one of two bodies.
//
// `expression` is a logical expression in the model's own language
// (`Customer.accountBalance >= 0`) rather than a physical binding, so it stays
// a plain string. Whatever evaluates the constraint resolves it against the
// ontology; the loader leaves it alone.
//
// `judgment` is the rule in words, for a rule no expression decides. It is a
// plain string for the same reason, and validate resolves the `Entity.field`
// tokens it mentions.
//
// Both are optional here and exactly one is required, which `validate` enforces
// so the author gets one message naming the constraint rather than a schema
// union error naming a position in the document.
const constraintSchema = z.object({
  name: z.string(),
  expression: z.string().optional(),
  judgment: z.string().optional(),
  description: z.string().optional(),
  // What the engine does; absent means `reject`. See VIOLATION_EFFECTS.
  on_violation: z.enum(VIOLATION_EFFECTS).optional(),
  // How grave it is; no default, and nothing reads it yet. See
  // CONSTRAINT_SEVERITIES.
  severity: z.enum(CONSTRAINT_SEVERITIES).optional(),
  ai_context: aiContextSchema.optional(),
  // No `custom_extensions`: it is a vanilla-Ossie surface, and `constraints` is
  // an extended-profile-only key, so the two never co-occur. See Constraint.
});

const modelBase = z.object({
  name: z.string(),
  description: z.string().optional(),
  ai_context: aiContextSchema.optional(),
  custom_extensions: z.array(customExtensionSchema).optional(),
  datasets: z.array(datasetBase).min(1),
  relationships: z.array(relationshipSchema).optional(),
  metrics: z.array(metricSchema).optional(),
  // A native deployment-target key (GOOGLE_VERSION only). Folded into a GOOGLE
  // `custom_extensions` block on the IR after validation (see convertModel).
  deployment_target: z.string().optional(),
  // Model-level write operations, also GOOGLE_VERSION only (see actionSchema).
  actions: z.array(actionSchema).optional(),
  constraints: z.array(constraintSchema).optional(),
});


// The vendor-scoped `custom_extensions` field, present in the validation schema
// ONLY under vanilla Ossie. Under the extended profile the same information is
// carried by native keys, so a `custom_extensions` field is rejected as unknown
// (§6; agreed with Dmitri). Spread into each object shape below.
function ceField(extended: boolean) {
  return extended ?
      {} :
      {custom_extensions: z.array(customExtensionSchema).optional()};
}

// Builds the document schema for one (bindingOptional, extended) combination.
// Every object is `.strict()`, so an unknown key is a hard error rather than
// silently dropped. Two axes shape it:
//   - `extended` selects the version's extension surface: under the extended
//     profile the native keys (`extends`, `abstract`, `deployment_target`) are
//     accepted and `custom_extensions` is rejected; under vanilla Ossie the
//     reverse. (`entities` is folded to `datasets` before validation, so it is
//     never a schema key -- see normalizeDocumentSugars.)
//   - `bindingOptional` relaxes the source rule: when false (any push with a
//     graph leg) each concrete dataset must name a `source`; when true (a
//     Knowledge-Catalog-only push) it is optional, so a purely logical model
//     loads. The abstract+source contradiction is rejected either way. Fields
//     are never required to carry an `expression`: a field with no `expression`
//     is simply unbound (there is no separate flag), and the availability pass
//     prunes it before generation -- so it is not a load error under either
//     `bindingOptional`.
function buildDocumentSchema(bindingOptional: boolean, extended: boolean) {
  const ce = ceField(extended);

  const field =
      z.object({
         name: z.string(),
         expression: expressionSchema.optional(),
         datatype: z.enum(DATA_TYPES).optional(),  // closed, case-sensitive
                                                   // vocabulary; see DATA_TYPES
         description: z.string().optional(),
         label: z.string().optional(),
         dimension: dimensionSchema.optional(),
         ai_context: aiContextSchema.optional(),
         ...ce,
       }).strict();

  const dataset =
      z.object({
         name: z.string(),
         source: z.string().optional(),
         primary_key: z.array(z.string()).optional(),
         unique_keys: z.array(z.array(z.string())).optional(),
         description: z.string().optional(),
         ai_context: aiContextSchema.optional(),
         fields: z.array(field).optional(),
         ...ce,
         // Inheritance is a native extension: only the extended profile accepts
         // it.
         ...(extended ? {
           extends: z.array(z.string()).optional(),
           abstract: z.boolean().optional(),
         } :
                        {}),
       })
          .strict()
          .superRefine((ds: any, ctx) => {
            const abstract = ds.abstract === true;
            // A concrete (non-abstract) dataset must name its backing table;
            // only an abstract one may omit `source`. Relaxed under
            // bindingOptional.
            if (!bindingOptional && !abstract && ds.source === undefined) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['source'],
                message:
                    `dataset '${ds.name}': a non-abstract dataset requires a ` +
                    `source; set 'source', or mark it 'abstract: true' if it has no table`,
              });
            }
            // The converse is always contradictory: an abstract dataset has no
            // physical table, so a `source` on it would be silently ignored.
            // Reject it always.
            if (abstract && ds.source !== undefined) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['source'],
                message:
                    `dataset '${ds.name}': an abstract dataset has no table; ` +
                    `remove 'source', or drop 'abstract: true' to bind it to that table`,
              });
            }
            // A field with no `expression` is unbound -- there is no separate
            // flag. A graph leg does not reject it: the availability pass
            // (pruneUnavailable) drops each unbound field, and whatever depends
            // on it, before generation, so a deployed graph presents only what
            // its binding answers. This is how one logical model serves several
            // stores from different profiles, so it is not a load error under
            // either `bindingOptional`.
          });

  const relationship =
      z.object({
         name: z.string(),
         from: z.string(),
         to: z.string(),
         from_columns: z.array(z.string()).min(1).optional(),
         to_columns: z.array(z.string()).min(1).optional(),
         description: z.string().optional(),
         ai_context: aiContextSchema.optional(),
         ...ce,
       })
          .strict()
          .superRefine((r, ctx) => {
            if ((r.from_columns === undefined) !==
                (r.to_columns === undefined)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message:
                    `relationship '${
                        r.name}': from_columns and to_columns must be given ` +
                    `together (both bind the edge) or both omitted (a logical edge); one ` +
                    `without the other is a half-bound join.`,
              });
            }
          });

  const metric =
      z.object({
         name: z.string(),
         expression: expressionSchema,
         datatype: z.enum(DATA_TYPES).optional(),  // closed, case-sensitive
                                                   // vocabulary; see DATA_TYPES
         description: z.string().optional(),
         ai_context: aiContextSchema.optional(),
         ...ce,
       }).strict();

  const parameter = z.object({
                       name: z.string(),
                       type: z.string(),
                     }).strict();

  const action = z.object({
                    name: z.string(),
                    description: z.string().optional(),
                    executor: executorSchema.nullish(),
                    parameters: z.array(parameter).optional(),
                    guards: z.array(z.string()).optional(),
                    affects: z.array(affectedConceptSchema).optional(),
                    ai_context: aiContextSchema.optional(),
                    ...ce,
                  }).strict();

  // Both bodies are optional here because the schema cannot say "one of these
  // two, never both". validateConstraints enforces the exclusivity, which also
  // lets it name the constraint and say which way it went wrong.
  const constraint = z.object({
                        name: z.string(),
                        expression: z.string().optional(),
                        judgment: z.string().optional(),
                        description: z.string().optional(),
                        // What a violation does; absent means `reject`, and
                        // a judgment must state it. See VIOLATION_EFFECTS.
                        on_violation: z.enum(VIOLATION_EFFECTS).optional(),
                        // How grave it is; no default. See
                        // CONSTRAINT_SEVERITIES.
                        severity: z.enum(CONSTRAINT_SEVERITIES).optional(),
                        ai_context: aiContextSchema.optional(),
                        ...ce,
                      }).strict();

  const model =
      z.object({
         name: z.string(),
         description: z.string().optional(),
         ai_context: aiContextSchema.optional(),
         datasets: z.array(dataset).min(1),
         relationships: z.array(relationship).optional(),
         metrics: z.array(metric).optional(),
         ...ce,
         // Native extension keys: extended profile only. `actions` and
         // `constraints` are among them because vanilla Ossie has neither
         // construct and no `custom_extensions` encoding for either, so under
         // OSSIE_VERSION such a key is rejected as unknown rather than
         // silently dropped.
         ...(extended ? {
           deployment_target: z.string().optional(),
           actions: z.array(action).optional(),
           constraints: z.array(constraint).optional(),
         } :
                        {}),
       }).strict();

  return z
      .object({
        version: z.string(),
        semantic_model: z.array(model).min(1),
      })
      .strict();
}

// Four immutable schema shapes exist -- (bindingOptional) x (extended) -- so
// build all four once at module load and select between them rather than
// reconstructing the whole field/dataset/model/document graph (with fresh
// superRefine closures) on every fromDocument call.
const documentSchemas = {
  'false-false': buildDocumentSchema(false, false),
  'false-true': buildDocumentSchema(false, true),
  'true-false': buildDocumentSchema(true, false),
  'true-true': buildDocumentSchema(true, true),
};
// Returns z.ZodTypeAny so the four distinct strict object types collapse to one
// static type here; the document is re-typed as DocumentDoc after a successful
// parse (see fromDocument), which the convert functions consume.
function makeDocumentSchema(
    bindingOptional: boolean, extended: boolean): z.ZodTypeAny {
  return documentSchemas[`${bindingOptional}-${extended}` as keyof typeof documentSchemas];
}

type ExpressionDoc = z.infer<typeof expressionSchema>;
type DatasetDoc = z.infer<typeof datasetBase>;
type FieldDoc = z.infer<typeof fieldBase>;
type RelationshipDoc = z.infer<typeof relationshipSchema>;
type MetricDoc = z.infer<typeof metricSchema>;
type ModelDoc = z.infer<typeof modelBase>;
type ActionDoc = z.infer<typeof actionSchema>;
type ConstraintDoc = z.infer<typeof constraintSchema>;
type ParameterDoc = z.infer<typeof parameterSchema>;
type AffectedConceptDoc = z.infer<typeof affectedConceptSchema>;
type ExecutorDoc = z.infer<typeof executorSchema>;
type CustomExtensionDoc = z.infer<typeof customExtensionSchema>;
// The whole document, as the convert functions see it: `version` plus the
// superset model shape (every version's keys, each optional -- modelBase is the
// superset). Each of the four strict schemas validates to a subset of this, so
// they share this one static type once parsed.
type DocumentDoc = {
  version: string; semantic_model: ModelDoc[]
};
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
// are one code path. Today that is the `entities:` alias for `datasets:`, which
// is a native extension accepted only under the extended profile. A model-level
// `deployment_target:` is a native key under the extended profile too, but it
// is left in place here and folded into a GOOGLE `custom_extensions` block on
// the IR after validation (see convertModel), so the strict schema can accept
// (and reject) it natively. Operates on the parsed document before validation.
function normalizeDocumentSugars(doc: unknown, extended: boolean): unknown {
  if (!doc || typeof doc !== 'object') return doc;
  const cloned = structuredClone(doc) as any;
  const models = cloned.semantic_model;
  if (!Array.isArray(models)) return cloned;
  for (const m of models) {
    if (m && typeof m === 'object') normalizeModelSugars(m, extended);
  }
  return cloned;
}

function normalizeModelSugars(m: any, extended: boolean): void {
  const label = typeof m.name === 'string' ? `model '${m.name}'` : 'model';

  // `entities` is a native alias for `datasets`, accepted only under the
  // extended profile. Under vanilla Ossie the key is unknown; surface a clear
  // message here rather than the strict schema's generic "unrecognized key".
  if (m.entities !== undefined) {
    if (!extended) {
      throw new Error(
          `Semantic model load error: ${label}: 'entities' is a ` +
          `'${GOOGLE_VERSION}' extension; use 'datasets', or set the document ` +
          `version to '${GOOGLE_VERSION}'.`);
    }
    if (m.datasets !== undefined) {
      throw new Error(
          `Semantic model load error: ${label}: set either ` +
          `'entities' or 'datasets', not both (they are the same key).`);
    }
    m.datasets = m.entities;
    delete m.entities;
  }
}

// Builds the GOOGLE custom-extension block that carries a model's
// `deployment_target` URI on the IR (the form the deploy leg reads). The native
// `deployment_target:` key (extended profile only) is folded into one after
// validation (see convertModel); the extended profile does not accept a
// `custom_extensions` carrier, so there is never a pre-existing GOOGLE block to
// reconcile with.
function deploymentTargetExtension(target: string): CustomExtension {
  return {
    vendorName: GOOGLE_VENDOR,
    data: JSON.stringify({deploymentTargets: [target]}),
  };
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
  const version = readVersion(doc);
  const extended = version === GOOGLE_VERSION;

  const normalized = normalizeDocumentSugars(doc, extended);
  const result = makeDocumentSchema(opts.bindingOptional ?? false, extended)
                     .safeParse(normalized);
  if (!result.success) {
    throw new Error(`Semantic model load error: ${result.error.message}`);
  }

  const warnings: string[] = [];
  const parsed = result.data as DocumentDoc;

  const models =
      parsed.semantic_model.map(m => convertModel(m, opts, warnings));
  return {models, warnings: [...new Set(warnings)]};
}

// Reads and validates the top-level `version`. It is REQUIRED and must be one
// of the accepted values: the version selects which extension surface is legal,
// so it cannot be guessed, and a missing or unrecognized version is a hard load
// error rather than a warning (agreed with Dmitri).
function readVersion(doc: unknown): string {
  const version =
      (doc && typeof doc === 'object') ? (doc as any).version : undefined;
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(
        `Semantic model load error: missing 'version'; declare ` +
        `'${OSSIE_VERSION}' (vanilla Ossie) or '${GOOGLE_VERSION}' (the ` +
        `extended profile) at the top level.`);
  }
  if (!ACCEPTED_VERSIONS.includes(version)) {
    throw new Error(
        `Semantic model load error: unknown version ` +
        `'${version}'; expected '${OSSIE_VERSION}' or '${GOOGLE_VERSION}'.`);
  }
  return version;
}


// Rejects names that appear more than once within a scope. Uniqueness is
// required for a valid graph: a duplicate dataset, field, metric, or
// relationship name makes the generated nodes, properties, or edges ambiguous,
// so a duplicate is a hard load error (agreed with Dmitri) rather than a
// warning.
function rejectDuplicateNames(
    names: string[], kind: string, scope: string): void {
  const seen = new Set<string>();
  for (const n of names) {
    if (seen.has(n)) {
      throw new Error(
          `${scope}: duplicate ${kind} '${n}'; names must be unique.`);
    }
    seen.add(n);
  }
}

function convertModel(
    m: ModelDoc, opts: LoadOptions, warnings: string[]): SemanticModel {
  const dialect = opts.dialect ?? DEFAULT_DIALECT;

  const entities =
      m.datasets.map(ds => convertDataset(ds, opts, warnings, dialect));
  rejectDuplicateNames(
      entities.map(e => e.name), 'dataset name', `model '${m.name}'`);

  const entityNames = entities.map(e => e.name);
  const entityNameSet = new Set(entityNames);

  const relationships =
      (m.relationships ?? []).map(r => convertRelationship(r, entityNameSet));
  rejectDuplicateNames(
      relationships.map(r => r.name), 'relationship name', `model '${m.name}'`);

  const metrics =
      (m.metrics ??
       []).map(mt => convertMetric(mt, entityNames, warnings, dialect));
  rejectDuplicateNames(
      metrics.map(mt => mt.name), 'metric name', `model '${m.name}'`);

  // Actions reference entities as parameter types and both entities and
  // relationships as affected concepts, so they are converted after each is
  // known.
  const relationshipNameSet = new Set(relationships.map(r => r.name));
  const actions = (m.actions ?? [])
                      .map(a => convertAction(
                               a, entityNameSet, relationshipNameSet, warnings));
  rejectDuplicateNames(
      actions.map(a => a.name), 'action name', `model '${m.name}'`);

  const constraints = (m.constraints ?? []).map(convertConstraint);
  rejectDuplicateNames(
      constraints.map(c => c.name), 'constraint name', `model '${m.name}'`);
  warnUnguardedParameterConstraints(actions, constraints, m.name, warnings);
  warnAllGuardsJudged(actions, constraints, m.name, warnings);

  const description = composeDescription(m.description);

  const model: SemanticModel = {name: m.name, entities, relationships, metrics};
  if (actions.length) model.actions = actions;
  if (constraints.length) model.constraints = constraints;
  if (description) model.description = description;
  const ai = aiContextOrUndefined(m.ai_context);
  if (ai) model.aiContext = ai;
  // Custom extensions ride vanilla Ossie's `custom_extensions` carrier or,
  // under the extended profile, come from folding the native
  // `deployment_target` key into a GOOGLE block (the two are mutually exclusive
  // by version).
  const ce = toCustomExtensions(m.custom_extensions);
  if (ce) model.customExtensions = ce;
  if (m.deployment_target !== undefined) {
    model.customExtensions = [
      ...(model.customExtensions ?? []),
      deploymentTargetExtension(m.deployment_target),
    ];
  }
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
  rejectDuplicateNames(
      fields.map(f => f.name), 'field name', `dataset '${ds.name}'`);

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
  if (f.expression !== undefined) {
    const picked = pickDialect(
        f.expression, dialect, `field '${entityName}.${f.name}'`, warnings);
    if (picked.expression !== undefined) field.expression = picked.expression;
    if (picked.importedExpression !== undefined) {
      field.importedExpression = picked.importedExpression;
      field.importedDialect = picked.importedDialect;
    }
  }
  // else: an unbound field. It carries meaning (label, description, AI context)
  // but names no physical column. A field is unbound exactly when it has no
  // `expression` -- there is no separate flag. A graph leg does not reject it:
  // the availability pass (pruneUnavailable) drops each unbound field, and
  // whatever depends on it, before generation, so one logical model can serve
  // stores that bind different subsets of columns.
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

// Converts a constraint document to the IR. Whichever body it declares is kept
// verbatim: an expression is a logical invariant resolved against the ontology
// by whatever evaluates it, and a judgment is the text a judge is handed.
// Description and AI context round-trip like everywhere else.
//
// Both bodies are copied when a document sets both, so `validate` can name the
// conflict against the real constraint rather than against a repaired one.
function convertConstraint(c: ConstraintDoc): Constraint {
  const constraint: Constraint = {name: c.name};
  if (c.expression !== undefined) constraint.expression = c.expression;
  if (c.judgment !== undefined) constraint.judgment = c.judgment;
  if (c.on_violation) constraint.onViolation = c.on_violation;
  if (c.severity) constraint.severity = c.severity;
  const description = composeDescription(c.description);
  if (description) constraint.description = description;
  const ai = aiContextOrUndefined(c.ai_context);
  if (ai) constraint.aiContext = ai;
  return constraint;
}

// Maps an authored action onto the IR. Parameter types are resolved against the
// model's entities; a type that is neither a known entity nor a scalar datatype
// is kept verbatim and warned, so the loader stays lenient (a strict `validate`
// gate can promote these later).
function convertAction(
    a: ActionDoc, entityNames: Set<string>, relationshipNames: Set<string>,
    warnings: string[]): Action {
  const parameters = (a.parameters ?? [])
                         .map(p => convertParameter(
                                  p, a.name, entityNames, warnings));
  // Parameter names address the inputs at dispatch, so a collision is as
  // ambiguous as a duplicate field or metric name -- reject it the same way.
  rejectDuplicateNames(
      parameters.map(p => p.name), 'parameter name', `action '${a.name}'`);

  const action: Action = {
    name: a.name,
    parameters,
  };
  // Absent when no binding supplies one -- the action is declared but not
  // performable here.
  if (a.executor != null) {
    action.executor = convertExecutor(a.executor);
  }
  if (a.guards?.length) {
    // A repeated guard would check one constraint twice while reading as two
    // rules, so it is rejected like any other duplicate name.
    rejectDuplicateNames(a.guards, 'guard', `action '${a.name}'`);
    action.guards = [...a.guards];
  }
  if (a.affects?.length) {
    const affects = a.affects.map(
        e => toAffectedConcept(
            e, a.name, entityNames, relationshipNames, warnings));
    rejectDuplicateAffectedConcepts(affects, a.name);
    warnMixedAffectsPrecision(affects, a.name, warnings);
    action.affects = affects;
  }

  const description = composeDescription(a.description);
  if (description) action.description = description;
  const ai = aiContextOrUndefined(a.ai_context);
  if (ai) action.aiContext = ai;
  const ce = toCustomExtensions(a.custom_extensions);
  if (ce) action.customExtensions = ce;
  return action;
}

// Maps one authored entry onto the IR, normalizing the two shapes to one.
//
// A bare name and a record with no `operation` mean the same thing, so both
// land as an entry whose operation is unset. Whether `Order` is an entity or
// an edge is neither authored nor stored -- it is a fact about the model, and
// nothing about the entry depends on it -- so the names are consulted only to
// warn about one that matches nothing, the way an unresolvable parameter type
// does. validate is where it becomes an error.
function toAffectedConcept(
    e: AffectedConceptDoc, actionName: string, entityNames: Set<string>,
    relationshipNames: Set<string>, warnings: string[]): AffectedConcept {
  const concept = typeof e === 'string' ? e : e.concept;

  const affected: AffectedConcept = {concept};
  if (!entityNames.has(concept) && !relationshipNames.has(concept)) {
    warnings.push(
        `action '${actionName}': affects names '${concept}', which is ` +
        `neither an entity nor a relationship in this model.`);
  }

  if (typeof e !== 'string') {
    if (e.operation !== undefined) affected.operation = e.operation;
    if (e.fields?.length) {
      // Naming one field twice says nothing the single mention does not.
      rejectDuplicateNames(
          e.fields, 'affected field',
          `action '${actionName}' affects '${concept}'`);
      affected.fields = [...e.fields];
    }
  }
  return affected;
}

// Two entries on the same concept with the same operation are one entry
// written twice. Rejected rather than warned, like a repeated guard: it states
// no second fact, and leaving it in would put a duplicate record in the catalog.
function rejectDuplicateAffectedConcepts(
    affects: AffectedConcept[], actionName: string): void {
  rejectDuplicateNames(
      affects.map(e => `${e.concept}/${e.operation ?? '(unspecified)'}`),
      'affected concept', `action '${actionName}'`);
}

// An entry with no operation covers the whole concept, so pairing it with a
// specific operation on that same concept says both "in some unstated way" and
// "in this exact way". That is almost always a half-finished edit -- the author
// added precision to one line and left the coarse one behind -- but it is not
// contradictory, so it warns rather than fails.
function warnMixedAffectsPrecision(
    affects: AffectedConcept[], actionName: string, warnings: string[]): void {
  const unspecified =
      new Set(affects.filter(e => !e.operation).map(e => e.concept));
  if (!unspecified.size) return;
  for (const concept of new Set(
           affects.filter(e => e.operation && unspecified.has(e.concept))
               .map(e => e.concept))) {
    warnings.push(
        `action '${actionName}': affects lists '${concept}' both with an ` +
        `operation and without one. The bare entry already covers every ` +
        `operation on '${concept}'; drop it, or give it an operation too.`);
  }
}

// An action every one of whose guards is judged has no deterministic gate at
// all. Every gate costs a model call, none can lower to a store-level `CHECK`,
// and each may decide two identical calls differently, so nothing protects the
// write when the judge is unavailable or wrong.
//
// This is a warning and not an error, because it may be exactly what the author
// meant: some operations really are governed only by rules no expression
// decides. It exists so that state is visible in the source rather than
// discovered from a published model.
function warnAllGuardsJudged(
    actions: Action[], constraints: Constraint[], modelName: string,
    warnings: string[]): void {
  if (!actions.length || !constraints.length) return;
  const judged = new Set(
      constraints.filter(c => c.judgment !== undefined).map(c => c.name));
  if (!judged.size) return;
  for (const a of actions) {
    const guards = a.guards ?? [];
    if (!guards.length || !guards.every(g => judged.has(g))) continue;
    warnings.push(
        `model '${modelName}': every constraint action '${a.name}' names in ` +
        `guards is judged, so the action has no deterministic gate. Every ` +
        `gate costs a model call, and none can lower to a store-level check.`);
  }
}

// A constraint that reads an action's parameter describes that call, so the
// only moment it can be checked is before the call runs -- which happens only
// when the action names it in `guards`. Such a constraint left unnamed by EVERY
// action is text nothing will ever evaluate, so say so at load time.
//
// Being guarded anywhere is enough. An action that shares the parameter name and
// does not name the constraint is a deliberate modeling choice, since the same
// rule may gate one action and leave another alone; warning about it would
// report a constraint that does run and would teach an author to ignore this
// message.
//
// This warns rather than fails because the scan matches identifiers, and an
// expression may use a bare name that merely coincides with a parameter name.
//
// One message per pair, naming the first parameter that matched.
function warnUnguardedParameterConstraints(
    actions: Action[], constraints: Constraint[], modelName: string,
    warnings: string[]): void {
  if (!actions.length || !constraints.length) return;
  for (const c of constraints) {
    if (actions.some(a => a.guards?.includes(c.name))) continue;
    // Judged constraints are skipped. The scan looks for a bare identifier that
    // matches a parameter name, and a judgment is ordinary prose, so words like
    // `amount` or `order` appear in it as English rather than as references.
    // Running the scan there would warn on most judged rules ever written.
    if (c.expression === undefined) continue;
    const identifiers = bareIdentifiers(c.expression);
    if (!identifiers.size) continue;
    for (const a of actions) {
      const read = a.parameters.find(p => identifiers.has(p.name));
      if (!read) continue;
      warnings.push(
          `model '${modelName}': constraint '${c.name}' reads '${
              read.name}', ` +
          `a parameter of action '${a.name}', but '${a.name}' does not list ` +
          `'${c.name}' in guards. A constraint over an action's parameters is ` +
          `checked only as a guard of that action.`);
    }
  }
}

// The names an expression uses on their own. A qualified `Entity.field` is
// consumed whole so its field half is never mistaken for a bare name, which is
// what makes `Part.availableStock >= quantity` yield `quantity` alone. Action
// parameters are referenced by bare name, so this is the set that can name one.
//
// A quoted literal is data rather than a reference, so it is blanked before the
// scan: `status = 'quantity'` must not look like a read of a parameter named
// `quantity`.
function bareIdentifiers(expression: string): Set<string> {
  const found = new Set<string>();
  const code = expression.replace(/'[^']*'|"[^"]*"/g, ' ');
  const token = /[A-Za-z_]\w*\s*\.\s*[A-Za-z_]\w*|([A-Za-z_]\w*)/g;
  for (let m = token.exec(code); m; m = token.exec(code)) {
    if (m[1]) found.add(m[1]);
  }
  return found;
}

// Resolves a parameter's authored `type` against the ontology: a known entity
// name makes it an object reference (isEntityRef = true); a scalar DataType makes
// it a value (isEntityRef = false). A type that is neither is kept verbatim with
// isEntityRef left unset, and warned.
function convertParameter(
    p: ParameterDoc, actionName: string, entityNames: Set<string>,
    warnings: string[]): ActionParameter {
  const param: ActionParameter = { name: p.name, type: p.type };
  if (entityNames.has(p.type)) {
    param.isEntityRef = true;
  } else if ((DATA_TYPES as readonly string[]).includes(p.type)) {
    param.isEntityRef = false;
  } else {
    warnings.push(
      `action '${actionName}': parameter '${p.name}' type '${p.type}' is ` +
      `neither a known entity nor a scalar datatype (${DATA_TYPES.join('/')})`);
  }
  return param;
}

// Normalizes the open format's single-key executor object to the IR's tagged
// union. The schema already guaranteed exactly one kind is present.
function convertExecutor(ex: ExecutorDoc): Executor {
  if (ex.mcp) return { kind: 'mcp', mcp: { ...ex.mcp } };
  if (ex.rest) return { kind: 'rest', rest: { ...ex.rest } };
  if (ex.sql) {
    return {
      kind: 'sql',
      sql: { statements: ex.sql.statements.map(t => t.trim()) },
    };
  }
  // The schema's refinement guarantees one of the four kinds is set.
  return { kind: 'grpc', grpc: { ...ex.grpc! } };
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
