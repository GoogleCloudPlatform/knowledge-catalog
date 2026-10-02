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

import {Action, ActionParameter, AffectedConcept, AiContext, CONCEPT_OPERATIONS, Constraint, CONSTRAINT_SEVERITIES, CustomExtension, DATA_TYPES, DataType, Entity, Executor, Field, Metric, normalizeDataType, Relationship, SemanticModel, VIOLATION_EFFECTS,} from './ir';
import {DeclaredConcept, declaredConceptFields} from './resolve_inheritance';
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
//     first-class. Ossie's `custom_extensions` carrier is accepted for
//     third-party vendors only; a GOOGLE block is rejected, since everything
//     it would carry is a native key here.
// Both parse into the same IR, so a downstream leg never sees the difference.
const OSSIE_VERSION = '0.2.0.dev0';
const GOOGLE_VERSION = '0.2.0.dev0/google';
// The declared flavor, as stored on the IR (SemanticModel.version).
type FormatVersion = NonNullable<SemanticModel['version']>;
const ACCEPTED_VERSIONS: readonly FormatVersion[] = [OSSIE_VERSION, GOOGLE_VERSION];

function isFormatVersion(v: string): v is FormatVersion {
  return (ACCEPTED_VERSIONS as readonly string[]).includes(v);
}



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
// structured object (Mapping Addendum 4).
//
// Three members are CLOSED, as in Ossie's schema: `instructions` is a string,
// and `synonyms` and `examples` are lists of strings (a non-string example is
// rejected, not dropped). Any other member is a CUSTOM member: opaque, any
// value, carried verbatim into AiContext.additionalProperties. Member names are
// case-sensitive, so `Synonyms` is a custom member, not a misspelled synonym.
// The flavors write custom members differently:
//   - Google: inside a `custom` mapping. Every other unknown key stays an error,
//     so a misspelled `synonyms` is still caught.
//   - Vanilla: as siblings of the three, as Ossie's open object allows. A
//     sibling named `custom` is a custom member like any other.
// The bare-string shorthand stands for `instructions` and has no custom
// members. Both object forms parse to the same shape (AiContextObjectDoc), so
// nothing downstream needs to know the flavor.
const AI_CONTEXT_MEMBERS = ['instructions', 'synonyms', 'examples'] as const;
const aiContextMembers = {
  instructions: z.string().optional(),
  synonyms: z.array(z.string()).optional(),
  examples: z.array(z.string()).optional(),
};

interface AiContextObjectDoc {
  instructions?: string;
  synonyms?: string[];
  examples?: string[];
  additionalProperties?: Record<string, unknown>;
}

// Keeps the closed members and attaches `custom` members only when there are
// any, so an object with none parses to exactly the closed shape.
function aiContextObject(
    closed: {instructions?: string, synonyms?: string[], examples?: string[]},
    custom: Record<string, unknown>): AiContextObjectDoc {
  const out: AiContextObjectDoc = {};
  if (closed.instructions !== undefined) out.instructions = closed.instructions;
  if (closed.synonyms !== undefined) out.synonyms = closed.synonyms;
  if (closed.examples !== undefined) out.examples = closed.examples;
  if (Object.keys(custom).length) out.additionalProperties = custom;
  return out;
}

const googleAiContextSchema = z.union([
  z.string(),
  z.object({
     ...aiContextMembers,
     custom: z.record(z.string(), z.unknown(), {
                error: `ai_context 'custom' must be a mapping of custom ` +
                    `member names to values`,
              }).optional(),
   })
      .strict()
      .superRefine((ai, ctx) => {
        // A closed member written inside `custom` is one vanilla could not
        // express, and almost always a misplaced line; name where it goes.
        for (const member of AI_CONTEXT_MEMBERS) {
          if (ai.custom && Object.hasOwn(ai.custom, member)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['custom', member],
              message: `ai_context 'custom' cannot hold '${member}'; it is ` +
                  `a standard member, so write it beside 'custom', not ` +
                  `inside it.`,
            });
          }
        }
      })
      .transform(({custom, ...closed}) => aiContextObject(closed, custom ?? {})),
]);

const vanillaAiContextSchema = z.union([
  z.string(),
  z.object(aiContextMembers).passthrough().transform(ai => {
    const custom: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(ai)) {
      if (!(AI_CONTEXT_MEMBERS as readonly string[]).includes(key)) {
        custom[key] = value;
      }
    }
    return aiContextObject(ai, custom);
  }),
]);

// The schema for one flavor. Actions, parameters and constraints exist only in
// the Google flavor, so they always take the Google form (aiContextSchema).
function aiContextSchemaFor(extended: boolean) {
  return extended ? googleAiContextSchema : vanillaAiContextSchema;
}
const aiContextSchema = googleAiContextSchema;

// A vendor-scoped extension block: opaque `data` (a JSON string) tagged by
// `vendor_name`. The spec allows these at every level (model, dataset, field,
// relationship, metric). All are preserved verbatim on the IR (see
// toCustomExtensions) for lossless round-trip; no vendor block is interpreted
// at load time -- typed views (e.g. off the GOOGLE block) are a consumer
// concern.
const customExtensionSchema = z.object({
  vendor_name: z.string(),
  data: z.string(),
}).strict();

// A field's dimension metadata; only the time flag is read today.
const dimensionSchema = z.object({
  is_time: z.boolean().optional(),
}).strict();

// The canonical (superset) field shape, for TYPE inference only. The actual
// validation schemas are rebuilt per-load by buildDocumentSchema, which is
// strict, gates the native extension keys on the version, and applies the
// source-completeness refinement. A field is BOUND when it names a physical
// column via `expression`; a field with no `expression` is UNBOUND (no column
// under this binding). A field is never required to be bound -- an unbound
// field loads and the availability pass prunes it before generation.
const fieldBase = z.object({
  name: z.string(),
  expression: expressionSchema.optional(),
  // A plain string here; whether it is valid, and its canonical spelling,
  // depend on the flavor and are decided in convertField (normalizeDataType).
  datatype: z.string().optional(),
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
  // The entity the metric belongs to, as the author wrote it. Google flavor
  // only (buildDocumentSchema rejects it in vanilla).
  entity: z.string().optional(),
  expression: expressionSchema,
  // A plain string; validated and canonicalized in convertMetric
  // (normalizeDataType).
  datatype: z.string().optional(),
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
// validate.ts, where the action's parameter list is in scope. validate.ts also
// holds the live pre-flight that plans each statement against the bound store,
// which is where a name the database does not have is caught. See SqlExecutor.
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
                  `executor requires exactly one kind, but ${
                      kinds.length} given ` +
                      `(${kinds.join(', ')})`,
            });
          }
        });

// An action parameter, in either of its two authored forms (see
// ir.ActionParameter). DERIVED states `concept` and `field` and no `type`;
// STANDALONE states a `type` and neither. Every key here is optional because
// which combination is legal depends on the other keys, and a zod union would
// report a document that got it wrong as a list of failed alternatives naming a
// position rather than the mistake. convertParameter decides instead, where the
// model is in scope and the message can name the fix.
const parameterSchema = z.object({
  // Optional: a derived parameter takes the field's name unless it renames it.
  name: z.string().optional(),
  // A scalar DataType, and only on a standalone parameter. Resolved against
  // the model in convertParameter, not here, so the schema stays a plain
  // string. `datatype` is accepted as an alias for `type` so parameters can be
  // written with the same key as entity fields and metrics.
  type: z.string().optional(),
  datatype: z.string().optional(),
  concept: z.string().optional(),
  field: z.string().optional(),
  description: z.string().optional(),
  label: z.string().optional(),
  ai_context: aiContextSchema.optional(),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
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

// A constraint: a named invariant over the ontology, stated in words.
//
// `judgment` is the rule as a sentence. It is a plain string -- validate
// resolves the `Entity.field` tokens it mentions, and nothing else reads into
// it. Optional here and required in fact, which `validate` enforces so the
// author gets one message naming the constraint rather than a schema union
// error naming a position in the document.
//
// `expression` is RESERVED, not supported. It named the removed second body, a
// boolean in the model's own language, and it is still accepted by the schema
// for one reason: a model written against the older shape should be told to
// restate the rule as a judgment, not handed an unrecognized-key error that
// says only that the word is unknown. `rejectExpressionBody` refuses it. See
// Constraint in ir.ts.
const constraintSchema =
    z.object({
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
       // No `custom_extensions`: it is a vanilla-Ossie surface, and
       // `constraints` is an extended-profile-only key, so the two never
       // co-occur. See Constraint.
     }).superRefine(rejectExpressionBody);

// Refuses the removed `expression` body, naming the constraint and saying where
// the rule goes instead. A hard error rather than a dropped key: a rule the
// author stated and the loader silently ignored is a guard that stops guarding.
function rejectExpressionBody(
    c: {name?: string, expression?: string}, ctx: z.RefinementCtx): void {
  if (c.expression === undefined) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['expression'],
    message: `constraint '${c.name}' states an expression. A constraint ` +
        `states its rule as a judgment, in words, and nothing evaluates an ` +
        `expression. Restate the rule under 'judgment' and give it an ` +
        `'on_violation'.`,
  });
}

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


// The vendor-scoped `custom_extensions` field, accepted in BOTH flavors at the
// five levels the format defines it on: model, dataset, field, relationship and
// metric. Which vendor blocks are legal where is a flavor rule, checked
// separately. Actions and constraints are extended-profile constructs with no
// `custom_extensions` encoding, so they do not take it.
const customExtensionsKey = {custom_extensions: z.array(customExtensionSchema).optional()};

// Builds the document schema for one (bindingOptional, extended) combination.
// Every object is `.strict()`, so an unknown key is a hard error rather than
// silently dropped. Two axes shape it:
//   - `extended` selects the version's extension surface: under the extended
//     profile the native keys (`extends`, `abstract`, `deployment_target`,
//     metric `entity`) are accepted; under vanilla Ossie they are not.
//     (`entities` is folded to `datasets` before validation, so it is never a
//     schema key -- see normalizeDocumentSugars.)
//   - `bindingOptional` relaxes the source rule: when false (any push with a
//     graph leg) each concrete dataset must name a `source`; when true (a
//     Knowledge-Catalog-only push) it is optional, so a purely logical model
//     loads. The abstract+source contradiction is rejected either way. Fields
//     are never required to carry an `expression`: a field with no `expression`
//     is simply unbound (there is no separate flag), and the availability pass
//     prunes it before generation -- so it is not a load error under either
//     `bindingOptional`.
function buildDocumentSchema(bindingOptional: boolean, extended: boolean) {
  // The five data levels take this flavor's ai_context; actions and
  // constraints are Google-only and keep the Google form.
  const aiContext = aiContextSchemaFor(extended);

  const field =
      z.object({
         name: z.string(),
         expression: expressionSchema.optional(),
         // Validated per flavor in convertField (normalizeDataType).
         datatype: z.string().optional(),
         description: z.string().optional(),
         label: z.string().optional(),
         dimension: dimensionSchema.optional(),
         ai_context: aiContext.optional(),
         ...customExtensionsKey,
       }).strict();

  const dataset =
      z.object({
         name: z.string(),
         source: z.string().optional(),
         primary_key: z.array(z.string()).optional(),
         unique_keys: z.array(z.array(z.string())).optional(),
         description: z.string().optional(),
         ai_context: aiContext.optional(),
         fields: z.array(field).optional(),
         ...customExtensionsKey,
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
            // In the Google flavor, a concrete (non-abstract) dataset must name
            // its backing table; only an abstract one may omit `source`. Relaxed
            // under bindingOptional. Vanilla has no `abstract` and requires
            // `source` unconditionally (see requireVanillaBindings).
            if (extended && !bindingOptional && !abstract &&
                ds.source === undefined) {
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
         ai_context: aiContext.optional(),
         ...customExtensionsKey,
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
         // Validated per flavor in convertMetric (normalizeDataType).
         datatype: z.string().optional(),
         description: z.string().optional(),
         ai_context: aiContext.optional(),
         ...customExtensionsKey,
         // An authored anchor is a native extension: extended profile only.
         // Vanilla still declares the key so the refinement below can reject it
         // with a message that names the fix, not a bare "unrecognized key".
         entity: extended ? z.string().optional() : z.unknown().optional(),
       })
          .strict()
          .superRefine((mt, ctx) => {
            if (extended || mt.entity === undefined) return;
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['entity'],
              message: `metric '${mt.name}': 'entity' is a ` +
                  `'${GOOGLE_VERSION}' extension. A '${OSSIE_VERSION}' ` +
                  `metric takes its entity from its expression: qualify a ` +
                  `column with it (e.g. 'COUNT(orders.id)'), or set the ` +
                  `document version to '${GOOGLE_VERSION}'.`,
            });
          });

  // The same shape the superset uses, closed to unknown keys. Restating it
  // here is what let the two disagree: a key added to one and not the other
  // parses in the loader's own type and is rejected by the document schema,
  // which reports it as an unrecognized key on a line the author just wrote
  // out of the guide.
  const parameter = parameterSchema.strict();

  const action = z.object({
                    name: z.string(),
                    description: z.string().optional(),
                    executor: executorSchema.nullish(),
                    parameters: z.array(parameter).optional(),
                    guards: z.array(z.string()).optional(),
                    affects: z.array(affectedConceptSchema).optional(),
                    ai_context: aiContextSchema.optional(),
                  }).strict();

  // `judgment` is optional here and required in fact, so validateConstraints
  // can name the constraint rather than a position in the document.
  // `expression` is the reserved name of the removed body; see
  // rejectExpressionBody, which is what turns it into a useful error.
  const constraint = z.object({
                        name: z.string(),
                        expression: z.string().optional(),
                        judgment: z.string().optional(),
                        description: z.string().optional(),
                        // What a violation does; required. See
                        // VIOLATION_EFFECTS.
                        on_violation: z.enum(VIOLATION_EFFECTS).optional(),
                        // How grave it is; no default. See
                        // CONSTRAINT_SEVERITIES.
                        severity: z.enum(CONSTRAINT_SEVERITIES).optional(),
                        ai_context: aiContextSchema.optional(),
                      })
                         .strict()
                         .superRefine(rejectExpressionBody);

  const model = z.object({
         name: z.string(),
         description: z.string().optional(),
         ai_context: aiContext.optional(),
         datasets: z.array(dataset).min(1),
         relationships: z.array(relationship).optional(),
         metrics: z.array(metric).optional(),
         ...customExtensionsKey,
                   // Native extension keys: extended profile only. `actions`
                   // and `constraints` are among them because vanilla Ossie has
                   // neither construct and no `custom_extensions` encoding for
                   // either, so under OSSIE_VERSION such a key is rejected as
                   // unknown rather than silently dropped.
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
        // The format allows exactly one model per document.
        semantic_model:
            z.array(model).min(1).superRefine((models, ctx) => {
              if (models.length > 1) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  path: [1],
                  message: `a document declares one model; split '${
                      models[1].name}' into its own file`,
                });
              }
            }),
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
// is read as `instructions`; a structured object keeps its parts, custom
// members included. `examples` needs no filtering: the schema already rejected
// any non-string example.
function normalizeAiContext(ai: AiContextDoc|undefined): AiContext {
  if (ai === undefined) return {};
  if (typeof ai === 'string') return {instructions: ai};
  const out: AiContext = {};
  if (ai.instructions) out.instructions = ai.instructions;
  if (ai.synonyms && ai.synonyms.length)
    out.synonyms = [...new Set(ai.synonyms)];
  if (ai.examples && ai.examples.length) out.examples = ai.examples;
  if (ai.additionalProperties) {
    out.additionalProperties = ai.additionalProperties;
  }
  return out;
}

// Normalizes `ai_context` and returns it only when it carries something, so the
// IR omits empty aiContext objects. Custom members count: an `ai_context` that
// carries only those is not blank.
function aiContextOrUndefined(ai: AiContextDoc|undefined): AiContext|undefined {
  const ctx = normalizeAiContext(ai);
  return (ctx.instructions || ctx.synonyms || ctx.examples ||
          ctx.additionalProperties) ?
      ctx :
      undefined;
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
// validation (see convertModel). The extended profile rejects any authored
// GOOGLE block (see rejectGoogleBlock), so there is never a pre-existing one to
// reconcile with.
function deploymentTargetExtension(target: string): CustomExtension {
  return {
    vendorName: GOOGLE_VENDOR,
    data: JSON.stringify({deploymentTargets: [target]}),
  };
}

// The levels a `custom_extensions` block may sit on.
type ExtensionLevel = 'model'|'dataset'|'field'|'relationship'|'metric';

// True when a block list names the GOOGLE vendor. `vendor_name` is a free-form,
// case-sensitive string (Mapping Addendum 3), so only an exact `GOOGLE`
// matches: a `Google` block names some other vendor and is carried like any
// third-party block.
function hasGoogleBlock(exts: CustomExtensionDoc[]|undefined): boolean {
  return !!exts?.some(e => e.vendor_name === GOOGLE_VENDOR);
}

// Rejects a GOOGLE `custom_extensions` block where the flavor gives it no
// meaning. In the Google flavor that is everywhere: each thing a GOOGLE block
// would carry is a native key there. In vanilla it is only a field, the one
// level the format defines no GOOGLE payload for. Third-party blocks are
// accepted at every level in both flavors.
function rejectGoogleBlock(
    exts: CustomExtensionDoc[]|undefined, version: FormatVersion,
    level: ExtensionLevel, ctx: string): void {
  if (!hasGoogleBlock(exts)) return;
  if (version === GOOGLE_VERSION) {
    throw new Error(
        `Semantic model load error: ${ctx}: a '${GOOGLE_VENDOR}' ` +
        `custom_extensions block is not accepted in a '${GOOGLE_VERSION}' ` +
        `document. Everything it would carry is a native key in this ` +
        `flavor; write it as one.`);
  }
  if (level === 'field') {
    throw new Error(
        `Semantic model load error: ${ctx}: a '${OSSIE_VERSION}' document ` +
        `cannot carry a '${GOOGLE_VENDOR}' custom_extensions block on a ` +
        `field; the format defines a ${GOOGLE_VENDOR} payload only on a ` +
        `model, dataset, relationship or metric.`);
  }
}

// Ossie's Relationship has no `description` key and its objects are closed, so
// a vanilla document that writes one is no longer valid Ossie. The description
// is still expressible there, inside a GOOGLE block; say so, with the notation.
function rejectVanillaRelationshipDescription(
    r: RelationshipDoc, version: FormatVersion): void {
  if (version !== OSSIE_VERSION || r.description === undefined) return;
  throw new Error(
      `Semantic model load error: relationship '${r.name}': a ` +
      `'${OSSIE_VERSION}' document cannot carry a plain 'description' on a ` +
      `relationship, since Ossie's Relationship has no such key. The ` +
      `description is still available; carry it in a ${GOOGLE_VENDOR} ` +
      `block on the relationship:\n` +
      `  custom_extensions:\n` +
      `    - vendor_name: ${GOOGLE_VENDOR}\n` +
      `      data: '{"description": "..."}'\n` +
      `or set the document version to '${GOOGLE_VERSION}'.`);
}

// Ossie's schema requires a dataset's `source`, a field's `expression`, and a
// relationship's `from_columns` and `to_columns`. The Model Spec relaxes all
// three in the Google flavor only, so a vanilla document must bind all three,
// with or without `GOOGLE` blocks. `bindingOptional` does not relax this: it
// decides what a push needs, not what the document must say to be valid Ossie.
function requireVanillaBindings(m: ModelDoc): void {
  const missing = (kind: string, name: string, key: string): never => {
    throw new Error(
        `Semantic model load error: ${kind} '${name}': a ${OSSIE_VERSION} ` +
        `document requires '${key}'. Only ${GOOGLE_VERSION} lets a ${kind} ` +
        `leave it to a profile.`);
  };
  for (const ds of m.datasets) {
    if (ds.source === undefined) missing('dataset', ds.name, 'source');
    for (const f of ds.fields ?? []) {
      if (f.expression === undefined) {
        missing('field', `${ds.name}.${f.name}`, 'expression');
      }
    }
  }
  for (const r of m.relationships ?? []) {
    if (r.from_columns === undefined) {
      missing('relationship', r.name, 'from_columns');
    }
    if (r.to_columns === undefined) {
      missing('relationship', r.name, 'to_columns');
    }
  }
}

/**
 * Loads YAML or JSON text (a document in the AI-first semantics format) into
 * the Semantic Model IR. `yaml.parse` accepts JSON too, so both are supported.
 */
export function loadModels(text: string, opts: LoadOptions = {}): LoadResult {
  let doc: unknown;
  try {
    // `resolveKnownTags: false` keeps YAML-only tags (`!!timestamp`,
    // `!!binary`) as the text written instead of turning them into Date or
    // Uint8Array, and reads `!!set` as a mapping with null values, so custom
    // `ai_context` members with no JSON counterpart stay text.
    doc = yaml.parse(text, {resolveKnownTags: false, logLevel: 'error'});
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

  const models = parsed.semantic_model.map(
      m => convertModel(m, version, opts, warnings));
  return {models, warnings: [...new Set(warnings)]};
}

// Reads and validates the top-level `version`. It is REQUIRED and must be one
// of the accepted values: the version selects which extension surface is legal,
// so it cannot be guessed, and a missing or unrecognized version is a hard load
// error rather than a warning (agreed with Dmitri).
function readVersion(doc: unknown): FormatVersion {
  const version =
      (doc && typeof doc === 'object') ? (doc as any).version : undefined;
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(
        `Semantic model load error: missing 'version'; declare ` +
        `'${OSSIE_VERSION}' (vanilla Ossie) or '${GOOGLE_VERSION}' (the ` +
        `extended profile) at the top level.`);
  }
  if (!isFormatVersion(version)) {
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
    m: ModelDoc, version: FormatVersion, opts: LoadOptions,
    warnings: string[]): SemanticModel {
  const dialect = opts.dialect ?? DEFAULT_DIALECT;

  rejectGoogleBlock(m.custom_extensions, version, 'model', `model '${m.name}'`);
  if (version === OSSIE_VERSION) {
    requireVanillaBindings(m);
  }

  const entities = m.datasets.map(
      ds => convertDataset(ds, version, opts, warnings, dialect));
  rejectDuplicateNames(
      entities.map(e => e.name), 'dataset name', `model '${m.name}'`);

  const entityNames = entities.map(e => e.name);
  const entityNameSet = new Set(entityNames);

  const relationships = (m.relationships ?? []).map(
      r => convertRelationship(r, version, entityNameSet));
  rejectDuplicateNames(
      relationships.map(r => r.name), 'relationship name', `model '${m.name}'`);

  const metrics = (m.metrics ?? []).map(
      mt => convertMetric(mt, version, entityNames, warnings, dialect));
  rejectDuplicateNames(
      metrics.map(mt => mt.name), 'metric name', `model '${m.name}'`);

  // Actions name both entities and relationships -- as affected concepts, and
  // as the concept a parameter projects its definition from -- so they are
  // converted after each is known.
  //
  // The lookup is the one validate uses, so a name resolves the same way in
  // both places, inheritance included. Resolving THROWS on an `extends` naming
  // an entity the model does not declare, which this loader is not the place to
  // report: it accepts such a model deliberately, and validate names the
  // failure once per model. So an unresolved view stands in -- but it is a view
  // in which NO entity has an inherited field, because the fallback drops
  // `extends` model-wide rather than from the one entity that broke. Warning
  // off it would tell an author that `Savings` does not declare `balance` when
  // `Savings extends Account` and `Account` declares it, sending them to fix
  // a parameter that is correct. So the projection warnings are withheld while
  // the view is degraded, and validate's one accurate line stands alone.
  const relationshipNameSet = new Set(relationships.map(r => r.name));
  let concepts: Map<string, DeclaredConcept>;
  let inheritanceResolved = true;
  try {
    concepts =
        declaredConceptFields({name: m.name, entities, relationships, metrics});
  } catch {
    inheritanceResolved = false;
    concepts = declaredConceptFields({
      name: m.name,
      entities: entities.map(e => ({...e, extends: undefined})),
      relationships,
      metrics,
    });
  }
  const actions = (m.actions ?? [])
                      .map(
                          a => convertAction(
                              a, concepts, entityNameSet, relationshipNameSet,
                              warnings, inheritanceResolved));
  rejectDuplicateNames(
      actions.map(a => a.name), 'action name', `model '${m.name}'`);

  const constraints = (m.constraints ?? []).map(convertConstraint);
  rejectDuplicateNames(
      constraints.map(c => c.name), 'constraint name', `model '${m.name}'`);

  const description = composeDescription(m.description);

  // `version` records the flavor the document was written in, so a consumer
  // (e.g. a pull) can return the model in that same flavor.
  const model: SemanticModel =
      {name: m.name, version, entities, relationships, metrics};
  if (actions.length) model.actions = actions;
  if (constraints.length) model.constraints = constraints;
  if (description) model.description = description;
  const ai = aiContextOrUndefined(m.ai_context);
  if (ai) model.aiContext = ai;
  // Authored custom extensions are carried verbatim. Under the extended
  // profile the native `deployment_target` key is folded into a GOOGLE block
  // appended after them; no authored GOOGLE block can collide with it, since
  // that flavor rejects one (see rejectGoogleBlock).
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
    ds: DatasetDoc, version: FormatVersion, opts: LoadOptions,
    warnings: string[], dialect: string): Entity {
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
  const fields = (ds.fields ?? []).map(
      f => convertField(f, ds.name, version, warnings, dialect));
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
  rejectGoogleBlock(ds.custom_extensions, version, 'dataset', ctxLabel);
  const ce = toCustomExtensions(ds.custom_extensions);
  if (ce) entity.customExtensions = ce;
  return entity;
}

// Resolves an authored `datatype` against the document's flavor: vanilla takes
// only the canonical spelling, the Google flavor any casing. An omitted
// datatype and `Opaque` both mean "no type" and come back undefined. A value
// the flavor does not accept is a load error naming the flavor in force, since
// the same string can be valid in one flavor and not the other.
function resolveDataType(
    raw: string|undefined, version: FormatVersion,
    ctx: string): Exclude<DataType, 'Opaque'>|undefined {
  const result = normalizeDataType(raw, version);
  if (!result.ok) {
    const accepted = version === GOOGLE_VERSION ?
        'any casing of' :
        'exactly one of';
    throw new Error(
        `Semantic model load error: ${ctx}: datatype '${raw}' is not valid ` +
        `in a '${version}' document; expected ${accepted} ` +
        `${DATA_TYPES.join(', ')}.`);
  }
  return result.type;
}

function convertField(
    f: FieldDoc, entityName: string, version: FormatVersion,
    warnings: string[], dialect: string): Field {
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
  const type =
      resolveDataType(f.datatype, version, `field '${entityName}.${f.name}'`);
  if (type) field.type = type;
  if (f.label) field.label = f.label;
  if (f.dimension) {
    field.dimension = {};
    if (f.dimension.is_time !== undefined)
      field.dimension.isTime = f.dimension.is_time;
  }
  if (description) field.description = description;
  const ai = aiContextOrUndefined(f.ai_context);
  if (ai) field.aiContext = ai;
  rejectGoogleBlock(
      f.custom_extensions, version, 'field', `field '${entityName}.${f.name}'`);
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
    r: RelationshipDoc, version: FormatVersion,
    entityNames: Set<string>): Relationship {
  const ctx = `relationship '${r.name}'`;
  rejectVanillaRelationshipDescription(r, version);
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
  rejectGoogleBlock(r.custom_extensions, version, 'relationship', ctx);
  const ce = toCustomExtensions(r.custom_extensions);
  if (ce) relationship.customExtensions = ce;
  return relationship;
}

function convertMetric(
    mt: MetricDoc, version: FormatVersion, entityNames: string[],
    warnings: string[], dialect: string): Metric {
  const ctx = `metric '${mt.name}'`;
  const picked = pickDialect(mt.expression, dialect, ctx, warnings);
  // Infer referenced entities from whichever expression form we have; the
  // imported form still carries the same entity qualifiers.
  const exprForRefs = picked.expression ?? picked.importedExpression ?? '';
  const referenced = referencedEntityNames(exprForRefs, entityNames);
  // An authored anchor (Google flavor only) says which entity the metric
  // belongs to, so an expression naming none -- `COUNT(*)` -- is not a problem
  // and is not warned about.
  if (mt.entity === undefined && !referenced.length) {
    warnings.push(`${
        ctx}: expression references no known entity; it may not be placeable downstream`);
  }
  const metric: Metric = {name: mt.name};
  if (mt.entity !== undefined) {
    // Like a relationship endpoint, an anchor must name a dataset the model
    // declares; a dangling one would attach the metric to nothing downstream.
    if (!entityNames.includes(mt.entity)) {
      throw new Error(
          `Semantic model load error: ${ctx}: 'entity' names '${mt.entity}', ` +
          `which is not a dataset in this model.`);
    }
    // What the author wrote wins over inference. `authoredEntity` records that
    // it was written, so a pull can write it back rather than re-infer it.
    metric.authoredEntity = mt.entity;
    metric.entity = mt.entity;
  } else if (referenced.length === 1) {
    // Attach only when the reference is unambiguous; a cross-entity metric is
    // left unattached (its qualifiers stay inline in the expression for
    // consumers).
    metric.entity = referenced[0];
  }
  if (picked.expression !== undefined) metric.expression = picked.expression;
  if (picked.importedExpression !== undefined) {
    metric.importedExpression = picked.importedExpression;
    metric.importedDialect = picked.importedDialect;
  }
  const type = resolveDataType(mt.datatype, version, ctx);
  if (type) metric.type = type;
  const description = composeDescription(mt.description);
  if (description) metric.description = description;
  const ai = aiContextOrUndefined(mt.ai_context);
  if (ai) metric.aiContext = ai;
  rejectGoogleBlock(mt.custom_extensions, version, 'metric', ctx);
  const ce = toCustomExtensions(mt.custom_extensions);
  if (ce) metric.customExtensions = ce;
  return metric;
}

// Converts a constraint document to the IR. The judgment is kept verbatim --
// it is the text a judge is handed. Description and AI context round-trip like
// everywhere else. A document that states `expression` never reaches here;
// rejectExpressionBody fails the parse.
function convertConstraint(c: ConstraintDoc): Constraint {
  const constraint: Constraint = {name: c.name};
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
    a: ActionDoc, concepts: Map<string, DeclaredConcept>,
    entityNames: Set<string>, relationshipNames: Set<string>,
    warnings: string[], inheritanceResolved = true): Action {
  const parameters =
      (a.parameters ?? [])
          .map(
              p => convertParameter(
                  p, a.name, concepts, warnings, inheritanceResolved));
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

// Maps one authored parameter onto the IR, resolving a derived one against the
// concept it projects from. See ir.ActionParameter for the two forms.
//
// What is a THROW here and what is a warning follows the split the rest of this
// file keeps. A contradiction in the parameter's own shape -- a `type` beside a
// `concept`, half a reference, no way to work out a name -- makes the document
// unloadable, because there is no reading of it to carry forward and the
// author's intent is not guessable. A reference that is well formed but does
// not resolve is kept verbatim and warned, the way an unresolvable `affects`
// concept is, and validate.ts promotes it to the error that stops a push.
//
// A referenced field that is UNBOUND -- no `expression`, so no column under
// this binding -- resolves like any other. That is deliberate. A metric or a
// relationship reading an unbound field is unavailable because it needs a
// column to read; a parameter needs only the logical definition, which an
// unbound field has in full. So a derived parameter never makes its action
// unavailable, and a logical-only model with no bindings at all publishes
// exactly as it would with them.
function convertParameter(
    p: ParameterDoc, actionName: string, concepts: Map<string, DeclaredConcept>,
    warnings: string[], inheritanceResolved = true): ActionParameter {
  const where = `action '${actionName}'`;
  if (p.type !== undefined && p.datatype !== undefined) {
    throw new Error(
        `${where}: parameter ${p.name ? `'${p.name}' ` : ''}states both ` +
        `'type' and 'datatype'; set one or the other (they are the same key).`);
  }
  const statedType = p.type ?? p.datatype;

  let conceptName = p.concept;
  let fieldName = p.field;
  // Support `field: Account.accountId` as a concise one-key shorthand for
  // `{concept: Account, field: accountId}`, matching the `Entity.field`
  // syntax used in metric expressions and constraint judgments.
  if (conceptName === undefined && fieldName !== undefined &&
      fieldName.includes('.')) {
    const parts = fieldName.split('.');
    if (parts.length === 2 && parts[0].length > 0 && parts[1].length > 0) {
      conceptName = parts[0];
      fieldName = parts[1];
    } else {
      throw new Error(
          `${where}: parameter ${p.name ? `'${p.name}' ` : ''}states 'field: ${
              fieldName}', which is not a valid 'Concept.field' reference; ` +
          `expected two dot-separated parts such as 'field: Order.orderId'.`);
    }
  } else if (conceptName !== undefined && fieldName?.includes('.')) {
    throw new Error(
        `${where}: parameter ${p.name ? `'${p.name}' ` : ''}states 'concept: ${
            conceptName}' alongside 'field: ${
            fieldName}', which already contains a concept prefix. ` +
        `Write either {concept: ${conceptName}, field: ${
            fieldName.split('.').pop()}} or {field: ${fieldName}}.`);
  }

  const hasConcept = conceptName !== undefined;
  const hasField = fieldName !== undefined;

  if (hasConcept !== hasField) {
    const given = hasConcept ? 'concept' : 'field';
    const missing = hasConcept ? 'field' : 'concept';
    throw new Error(
        `${where}: parameter ${p.name ? `'${p.name}' ` : ''}states '${
            given}' without '${missing}'. A parameter projected from a field ` +
        `states both, as two separate keys: ` +
        `{concept: Order, field: orderId} (or 'field: Order.orderId').`);
  }

  if (hasConcept && statedType !== undefined) {
    const typeKey = p.datatype !== undefined ? 'datatype' : 'type';
    const projectionDesc = p.concept !== undefined ?
        `'concept: ${p.concept}' and 'field: ${p.field}'` :
        `'field: ${p.field}'`;
    throw new Error(
        `${where}: parameter ${p.name ? `'${p.name}' ` : ''}states a '${
            typeKey}' alongside ${projectionDesc}. A ` +
        `projected parameter takes its type from the field, so stating one ` +
        `here is a second place for it to be wrong: if the type is wrong, ` +
        `fix the field; if the call needs a different one, cast in the DML.`);
  }

  const name = p.name ?? fieldName;
  if (name === undefined) {
    throw new Error(
        `${where}: a parameter states neither a 'name' nor a 'field' to take ` +
        `one from.`);
  }

  const param: ActionParameter = {name};
  if (hasConcept) {
    // Kept whether or not it resolves: it is what the author wrote, and a
    // round-trip that dropped it would turn a projected parameter into a
    // standalone one carrying a type nobody stated.
    param.concept = conceptName;
    param.field = fieldName;
  }

  const concept = hasConcept ? concepts.get(conceptName!) : undefined;
  const field = concept?.fields.get(fieldName!);
  if (hasConcept && !concept) {
    warnings.push(
        `${where}: parameter '${name}' projects from '${conceptName}', which ` +
        `is neither an entity nor a relationship in this model.`);
  } else if (hasConcept && !field && inheritanceResolved) {
    // Gated: with inheritance unresolved every entity looks like it declares
    // only its own fields, so this would fire on projections that are fine.
    warnings.push(`${where}: parameter '${name}' projects field '${
        fieldName}', which ${concept!.kind} '${
        conceptName}' does not declare.`);
  }

  // The field's definition flows down; the parameter's own wording wins over
  // it. The type never does -- a projected parameter states none at all.
  if (field?.type !== undefined) param.type = field.type;
  if (statedType !== undefined) param.type = statedType;
  const description = p.description ?? field?.description;
  if (description !== undefined) param.description = description;
  const label = p.label ?? field?.label;
  if (label !== undefined) param.label = label;
  const ai = aiContextOrUndefined(p.ai_context) ?? field?.aiContext;
  if (ai) param.aiContext = ai;
  // Never inherited. A field says what a thing HAS; whether a CALL must supply
  // a value for it is the action's own business.
  if (p.required !== undefined) param.required = p.required;
  if (p.default !== undefined) param.default = p.default;

  if (param.type === undefined) {
    if (!hasConcept) {
      warnings.push(
          `${where}: parameter '${name}' states no 'type' and projects no ` +
          `field. A parameter with no field behind it declares its own ` +
          `scalar type (${DATA_TYPES.join('/')}).`);
    } else if (field && inheritanceResolved) {
      // The projection resolved and the field is simply untyped, which is a
      // third case and not the one above: the author wrote the parameter
      // correctly, so the fix is on the field. A reference that did NOT
      // resolve was already warned about above and says why there is no type.
      warnings.push(
          `${where}: parameter '${name}' projects field '${conceptName}.${
              fieldName}', which declares no datatype, so the parameter has ` +
          `none either. Give that field a scalar type (${
              DATA_TYPES.join('/')}).`);
    }
  } else if (!(DATA_TYPES as readonly string[]).includes(param.type)) {
    // A type naming a concept is the old entity-reference spelling, which has
    // no meaning now: a parameter carries a value, so the way to take one FROM
    // an entity is to name the field it comes from.
    const named = concepts.get(param.type);
    warnings.push(
        named ?
            `${where}: parameter '${name}' is typed '${param.type}', which ` +
                `is ${
                    named.kind === 'entity' ? 'an entity' :
                                              'a relationship'} rather ` +
                `than a scalar datatype. A parameter carries a value; to ` +
                `take one from ${param.type}, project it with ` +
                `{concept: ${param.type}, field: <field>}.` :
            `${where}: parameter '${name}' type '${param.type}' is not a ` +
                `scalar datatype (${DATA_TYPES.join('/')})`);
  }
  return param;
}

// Normalizes the open format's single-key executor object to the IR's tagged
// union. The schema already guaranteed exactly one kind is present.
function convertExecutor(ex: ExecutorDoc): Executor {
  if (ex.mcp) return {kind: 'mcp', mcp: {...ex.mcp}};
  if (ex.rest) return {kind: 'rest', rest: {...ex.rest}};
  if (ex.sql) {
    return {
      kind: 'sql',
      sql: {statements: ex.sql.statements.map(t => t.trim())},
    };
  }
  // The schema's refinement guarantees one of the four kinds is set.
  return {kind: 'grpc', grpc: {...ex.grpc!}};
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
