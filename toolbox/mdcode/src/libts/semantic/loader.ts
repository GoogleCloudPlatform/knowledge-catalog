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

import {deploymentTargetKey} from './deployment_target';
import {Action, ActionParameter, AffectedConcept, AiContext, ALLOWED_DIALECTS, CONCEPT_OPERATIONS, Constraint, CONSTRAINT_SEVERITIES, CustomExtension, DATA_TYPES, DataType, DialectExpression, Entity, Executor, Field, isFieldBound, Metric, normalizeDataType, ProfileSpec, Relationship, SemanticModel, SqlDialect, VIOLATION_EFFECTS,} from './ir';
import {NameKind, nameProblem} from './names';
import {DeclaredConcept, declaredConceptFields} from './resolve_inheritance';
import {DEFAULT_PROFILE, fieldsOnTables, importCommand, importHint, noTextFor, profileSpecOf, sourcesDialect, TableDialects, tableDialects, TranspileOutcomes} from './resolve_profiles';
import {columnsForSource, entitiesReached, withoutQualifier} from './sql_expr_utils';
import {holdsNoSql, SqlColumn, withoutComments} from './sql_parser';
import {doubleQuotedNames, hasDoubleQuotedColumn} from './transpile';
import {parseLeniently, YAML_OPTIONS, yamlErrorMessage} from './yaml_options';

export interface LoadOptions {
  dialect?: string;  // preferred expression dialect; default 'BIGQUERY'
  // Accept a purely logical model: do not require a `source` on each concrete
  // dataset. Set for a Knowledge-Catalog-only push, which governs the logical
  // model (meaning) and needs no physical binding. Graph legs
  // (BigQuery/Spanner) never set it -- a concrete dataset with no table cannot
  // back a graph. A field's `expression` is never required either way: a field
  // with none is unbound and the availability pass prunes it. The
  // abstract+source contradiction stays enforced regardless.
  bindingOptional?: boolean;
  // The dialects sourceDialects found before the load, keyed as
  // dialectLookupKey gives: each Cloud SQL and third-party table's, and each
  // Spanner database's. Without this map such a source implies no dialect, as
  // dialectOfSources describes.
  sourceDialects?: ReadonlyMap<string, string>;
  // Turns `parseSource`'s rejection of an unaccepted table source form into a
  // warning so a caller can load a document whose sources have not all been
  // repointed yet.
  warnUnacceptedSource?: boolean;
  // The caller rejects a field its own table cannot run, as push does for a
  // model file, so the load warns about it only on a table of the preferred
  // dialect, and on a Cloud SQL, Spanner or third-party table no lookup has
  // read, since the caller does not check that one.
  fieldTextChecked?: boolean;
  // The flavor whose word for an entry of `entities` the load's messages use,
  // when it is not the document's own. kcmd import uses the word of the
  // flavor it writes.
  messageFlavor?: FormatVersion;
  // Set when kcmd import checks what it writes for a file another product
  // wrote, unless it writes a GOOGLE block over that file. The load sets
  // SemanticModel.thirdPartyImport on each model.
  thirdPartyImport?: boolean;
  // The name push's messages give the document the load reads, by which
  // `transpileOutcomes` holds what the import the advice to add a BigQuery
  // text suggests gives for it. Defaults to the model's name.
  document?: string;
  // What the import the advice to add a BigQuery text suggests gives, which
  // the advice names when it would stop. Without it, the advice names the
  // command alone.
  transpileOutcomes?: TranspileOutcomes;
}

export interface LoadResult {
  models: SemanticModel[];
  warnings: string[];
}

// The error the loader throws for a mistake in a document it reads, and that
// code reading a profile throws for a mistake in a profile. A caller that
// reports such an error to the author catches this class only, so an internal
// bug still surfaces as one.
export class SemanticModelError extends Error {}

// Message texts the loader gives, shared with code that checks the same rules
// on a model already loaded. The texts that end in Problem leave out the
// relationship, so a caller can name it in its own way.
export const HALF_BOUND_JOIN_PROBLEM = `from_columns and to_columns must be ` +
    `given together (both bind the edge) or both omitted (a logical edge); ` +
    `one without the other is a half-bound join.`;

function halfBoundJoinMessage(relationship: string): string {
  return `relationship '${relationship}': ${HALF_BOUND_JOIN_PROBLEM}`;
}

export function joinLengthProblem(from: number, to: number): string {
  return `from_columns (${from}) and to_columns (${to}) have different ` +
      `lengths; the join keys are mismatched`;
}

export function joinLengthMessage(
    relationship: string, from: number, to: number): string {
  return `relationship '${relationship}': ${joinLengthProblem(from, to)}`;
}

// `word` is what the message calls an entity, as entityWord gives it.
export function undefinedEndpointProblem(
    side: 'from'|'to', entity: string, word: string): string {
  return `'${side}' ${word} '${entity}' is not defined in the model`;
}

function sourceRequiredMessage(entity: string): string {
  return `entity '${entity}': a non-abstract entity requires a ` +
      `source; set 'source', or mark it 'abstract: true' if it has no table`;
}

export const DEFAULT_DIALECT = 'BIGQUERY';
const FALLBACK_DIALECT = 'ANSI_SQL';
// The two accepted format versions. Every document MUST declare one at the top
// level (a missing or unrecognized `version` is a load error). The value
// selects which extension surface is legal:
//   - OSSIE_VERSION: vanilla Apache Ossie. kcmd's extensions ride ONLY in
//     Ossie's `custom_extensions` carrier; the native extension keys
//     (`entities` alias, `extends`, `abstract`, `deployments`, `actions`,
//     `constraints`) are not accepted.
//   - GOOGLE_VERSION: kcmd's extended profile. The native extension keys are
//     first-class. Ossie's `custom_extensions` carrier is accepted for
//     third-party vendors only; a GOOGLE block is rejected, since everything
//     it would carry is a native key here.
// Both parse into the same IR, so a downstream leg never sees the difference.
export const OSSIE_VERSION = '0.2.0.dev0';
export const GOOGLE_VERSION = '0.2.0.dev0/google';
// How a vanilla author declares deployments: in a GOOGLE block on the model,
// or under `deployments:` after a switch to the Google flavor.
const DEPLOYMENTS_VERSION_HINT =
    `list 'deployments' in a GOOGLE custom_extensions block on the model, or ` +
    `set version: '${GOOGLE_VERSION}' and use 'deployments:'`;
/**
 * The declared format version, as stored on the IR
 * (`SemanticModel.version`).
 */
export type FormatVersion = NonNullable<SemanticModel['version']>;
const ACCEPTED_VERSIONS: readonly FormatVersion[] = [
  OSSIE_VERSION,
  GOOGLE_VERSION,
];

export function isFormatVersion(v: string): v is FormatVersion {
  return (ACCEPTED_VERSIONS as readonly string[]).includes(v);
}

// What a message calls an entry of a model's `entities` in a model of
// `version`. A '0.2.0.dev0' model lists them under `datasets` and calls each a
// dataset.
export function entityWord(version?: FormatVersion): 'entity'|'dataset' {
  return version === OSSIE_VERSION ? 'dataset' : 'entity';
}

/**
 * The location of an IR construct in documents of a given format version:
 * - `'native'`: a direct key on the YAML object (`deployments:`, `extends:`)
 * - `'file'`: a `<model>.profile.<name>.yaml` sidecar file (`profiles`)
 * - `'block'`: a `GOOGLE` `custom_extensions` block on the owning YAML object
 * - `'none'`: unsupported in this format version (rejected on load, warned and
 *   omitted on write)
 */
export type ConstructPlacement = 'native'|'file'|'block'|'none';

// One placement per construct key K at an object level.
type Placements<K extends string> = Readonly<Record<K, ConstructPlacement>>;

/**
 * The construct placements for a single format version, grouped by owning YAML
 * object level.
 */
export interface ConstructPlacements {
  readonly model: Placements<'profiles'|'deployments'|'actions'|'constraints'>;
  readonly dataset: Placements<'extends'|'abstract'>;
  readonly relationship: Placements<'description'>;
  readonly metric: Placements<'entity'>;
}

/**
 * Where each format version places each Google extension construct. Other
 * differences between the versions, such as required bindings and datatype
 * casing, are checked where they are read.
 */
export const FORMAT_VERSION_PLACEMENT:
    Readonly<Record<FormatVersion, ConstructPlacements>> = {
      [GOOGLE_VERSION]: {
        model: {
          profiles: 'file',
          deployments: 'native',
          actions: 'native',
          constraints: 'native',
        },
        dataset: {
          extends: 'native',
          abstract: 'native',
        },
        relationship: {
          description: 'native',
        },
        metric: {
          entity: 'native',
        },
      },
      [OSSIE_VERSION]: {
        model: {
          profiles: 'block',
          deployments: 'block',
          actions: 'none',
          constraints: 'none',
        },
        dataset: {
          extends: 'block',
          abstract: 'none',
        },
        relationship: {
          description: 'block',
        },
        metric: {
          entity: 'block',
        },
      },
    };

// An expression is supplied as one or more per-dialect variants, or (in the
// Google flavor only) as a bare SQL string shorthand for a single ANSI_SQL
// entry. Every dialect is validated against ALLOWED_DIALECTS (exact casing in
// both flavors), and a repeated dialect inside one list is rejected.
const expressionDialectEntrySchema =
    z.object({
       dialect: z.string().superRefine((d, ctx) => {
         if (!(ALLOWED_DIALECTS as readonly string[]).includes(d)) {
           ctx.addIssue({
             code: z.ZodIssueCode.custom,
             message: `Unknown dialect '${d}' in expression dialects. ` +
                 `Expected one of ${ALLOWED_DIALECTS.join(', ')}.`,
           });
         }
       }),
       expression: z.string(),
     }).strict();

const expressionObjectSchema =
    z.object({
       dialects: z.array(expressionDialectEntrySchema)
                     .min(1)
                     .superRefine((entries, ctx) => {
                       const seen = new Set<string>();
                       for (let i = 0; i < entries.length; i++) {
                         const d = entries[i].dialect;
                         if (seen.has(d)) {
                           ctx.addIssue({
                             code: z.ZodIssueCode.custom,
                             path: [i, 'dialect'],
                             message:
                                 `Duplicate dialect '${d}' in expression dialects.`,
                           });
                         }
                         seen.add(d);
                       }
                     }),
     }).strict();

const expressionSchema = z.union([
  z.string(),
  expressionObjectSchema,
]);

// Why `text`, an expression written for `dialect`, holds no SQL: it "is
// blank", "is only a comment", or, for a field of `entity`, is only that
// entity's qualifier, which the graph generators remove. Undefined when it
// holds SQL. The SQL parser decides what is a comment. It reads an ANSI_SQL
// text as generic SQL and as BigQuery SQL, since the graph generators read
// that text as BigQuery SQL, where `#` also starts a comment.
export function noSqlReason(
    text: string, dialect: string, entity?: string): string|undefined {
  if (text.trim() === '') return 'is blank';
  const readers = dialect === 'ANSI_SQL' ? ['ANSI_SQL', 'BIGQUERY'] : [dialect];
  if (readers.some(d => holdsNoSql(text, d))) return 'is only a comment';
  if (entity === undefined) return undefined;
  const onlyQualifier = (d: string) =>
      withoutQualifier(withoutComments(text, d), entity, d).trim() === '';
  return readers.some(onlyQualifier) ? `is only the qualifier '${entity}.'` :
                                       undefined;
}

// Why an expression cannot load, or undefined. It cannot load when its string
// form, or any of its dialect entries, holds no SQL. The problem names each
// such entry. No expression at all passes. `entity` is the entity a field
// expression belongs to, and is absent for a metric.
function noSqlProblem(
    raw: ExpressionDoc|undefined, entity?: string): string|undefined {
  if (typeof raw === 'string') {
    const reason = noSqlReason(raw, 'ANSI_SQL', entity);
    return reason && `'expression' ${reason}`;
  }
  return listed((raw?.dialects ?? []).flatMap(d => {
    const reason = noSqlReason(d.expression, d.dialect, entity);
    return reason ? [`the ${d.dialect} entry of 'expression' ${reason}`] : [];
  }));
}

// `problems` as one list, "a, b and c", or undefined when there are none.
// `conjunction` replaces the "and".
export function listed(problems: string[], conjunction = 'and'): string|
    undefined {
  if (problems.length < 2) return problems[0];
  return `${problems.slice(0, -1).join(', ')} ${conjunction} ${
      problems[problems.length - 1]}`;
}

// Selects the singular or plural form based on `n` (English count agreement).
export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

// Whether reading `doc` for a field of `entity` names `text`, or finds every
// problem that reading `text` in `dialect` finds. The string form and an
// ANSI_SQL entry are read both as ANSI_SQL and as BigQuery.
function docReads(
    doc: ExpressionDoc|undefined, text: string, dialect: string,
    entity?: string): boolean {
  const covers = (read: string) => read === dialect ||
      read === 'ANSI_SQL' && dialect === 'BIGQUERY' ||
      noSqlReason(text, read, entity) !== undefined;
  if (typeof doc === 'string') return doc === text && covers('ANSI_SQL');
  return (doc?.dialects ?? [])
      .some(d => d.expression === text && covers(d.dialect));
}

// `f`'s expression as a document writes it: its string form or its dialect
// list. A binding built in memory with no dialect list gives its imported
// text as an entry of its imported dialect. When it also has a target text,
// that text is a BIGQUERY entry beside it, as serializeModel writes the two. A
// target text alone is the string form. So is a target text beside an
// imported text that a dialect list cannot hold: one with no imported
// dialect, or one marked BIGQUERY, since a list names each dialect once. An
// imported text with no imported dialect and no target text is the string
// form too. Undefined when `f` carries no text.
export function expressionDocOf(
    f: Pick<
        Field,
        'expression'|'dialects'|'stringForm'|'importedExpression'|
        'importedDialect'>): string|{dialects: DialectExpression[]}|undefined {
  if (f.dialects?.length) {
    return f.stringForm ? f.dialects[0].expression : {dialects: f.dialects};
  }
  if (f.importedExpression === undefined || !f.importedDialect ||
      f.expression !== undefined && f.importedDialect === 'BIGQUERY') {
    return f.expression ?? f.importedExpression;
  }
  const imported = {
    dialect: f.importedDialect as SqlDialect,
    expression: f.importedExpression,
  };
  return {
    dialects: f.expression === undefined ?
        [imported] :
        [{dialect: 'BIGQUERY', expression: f.expression}, imported],
  };
}

// Why a field or metric holds no SQL, or undefined. Its expression is read as
// a document writes it, as expressionDocOf gives it. Then its target text is
// read as BigQuery, and its imported text in its imported dialect, or as
// BigQuery with none, unless that reading already read or named it.
// serializeModel writes both. Either text can be outside the dialect list
// when the field or metric was built in memory. The problem names each text
// that holds no SQL. `entity` is the entity a field belongs to, and is absent
// for a metric.
export function noSqlProblemOf(
    x: Pick<
        Field,
        'expression'|'dialects'|'stringForm'|'importedExpression'|
        'importedDialect'>,
    entity?: string): string|undefined {
  const doc = expressionDocOf(x);
  const problems = [noSqlProblem(doc, entity)];
  const texts = [
    ['expression', x.expression, 'BIGQUERY'],
    ['importedExpression', x.importedExpression, x.importedDialect ?? 'BIGQUERY'],
  ] as const;
  for (const [key, text, dialect] of texts) {
    if (text === undefined || docReads(doc, text, dialect, entity)) continue;
    const reason = noSqlReason(text, dialect, entity);
    problems.push(reason && `'${key}' ${reason}`);
  }
  return listed(problems.filter((p): p is string => p !== undefined));
}

// Why each field an entity inherits holds no SQL on that entity, one message
// per field. `concepts` gives each entity's fields with inheritance resolved,
// so an inherited text has lost its ancestor's qualifier. That can leave only
// the entity's own qualifier, as `base.orders.` does on `orders`, which the
// graph generators also remove. A field the entity binds itself keeps its own
// text, which is checked where it is declared, so it is left out. So is
// every field of an entity that extends no other. A problem that names no
// entity, such as a `-- todo` text, is reported where the field is declared,
// so a field is reported on the entity only when the entity adds to it.
// `problemOf` says why one field holds no SQL, on one entity when one is
// named. Unless given, it reads the field as a document writes it, each
// dialect entry in its own dialect, whatever dialect picked the target text.
export function inheritedNoSqlProblems(
    entities: Entity[], concepts: Map<string, DeclaredConcept>,
    problemOf: (f: Field, entity?: string) => string | undefined =
        (f, entity) => noSqlProblem(expressionDocOf(f), entity)): string[] {
  const problems: string[] = [];
  for (const e of entities) {
    if (!e.extends?.length) continue;
    const own = new Set((e.fields ?? []).filter(isFieldBound).map(f => f.name));
    for (const f of concepts.get(e.name)?.fields.values() ?? []) {
      if (own.has(f.name)) continue;
      const problem = problemOf(f, e.name);
      if (problem && problem !== problemOf(f)) {
        problems.push(`entity '${e.name}' inherits field '${
            f.name}': read on '${e.name}', ${problem}; write the field's SQL`);
      }
    }
  }
  return problems;
}

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
     custom: z.record(z.string(), z.unknown()).optional(),
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
// relationship, metric). A vanilla document's GOOGLE blocks on a model,
// dataset, relationship or metric are read into the IR (see readGoogleBlocks).
// rejectGoogleBlock says where a GOOGLE block is rejected. Every other block is
// kept verbatim.
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
      message: halfBoundJoinMessage(r.name),
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
  name: z.string().min(1).optional(),
  // A scalar DataType, and only on a standalone parameter. Resolved against
  // the model in convertParameter, not here, so the schema stays a plain
  // string. `datatype` is accepted as an alias for `type` so parameters can be
  // written with the same key as entity fields and metrics.
  type: z.string().optional(),
  datatype: z.string().optional(),
  concept: z.string().optional(),
  field: z.string().optional(),
  description: z.string().min(1).optional(),
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
    c: {name?: string, expression?: unknown}, ctx: z.RefinementCtx): void {
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

const deploymentSchema =
    z.object({
       name: z.string(),
       target: z.string().min(1),
       profile: z.string().min(1).optional(),
     }).strict();

const modelBase = z.object({
  name: z.string(),
  description: z.string().optional(),
  ai_context: aiContextSchema.optional(),
  custom_extensions: z.array(customExtensionSchema).optional(),
  datasets: z.array(datasetBase).min(1),
  relationships: z.array(relationshipSchema).optional(),
  metrics: z.array(metricSchema).optional(),
  // Named deployment targets (GOOGLE_VERSION only).
  deployments: z.array(deploymentSchema).optional(),
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

// The schemas of keys a document schema accepts only so that the loader can
// reject them with its own message. A message about an unknown key does not
// list them among the keys an object takes.
const UNLISTED_KEYS = new WeakSet<z.ZodType>();
function unlisted<T extends z.ZodType>(schema: T): T {
  UNLISTED_KEYS.add(schema);
  return schema;
}

// Builds the document schema for one (bindingOptional, extended) combination.
// Every object is `.strict()`, so an unknown key is a hard error rather than
// silently dropped. Two axes shape it:
//   - `extended` selects the version's extension surface: under the extended
//     profile the native keys (`extends`, `abstract`, `deployments`,
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
  const placement =
      FORMAT_VERSION_PLACEMENT[extended ? GOOGLE_VERSION : OSSIE_VERSION];
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
         // Inheritance (`extends`, `abstract`) is a native extension in the
         // extended profile only. Vanilla still declares both keys so the
         // refinement below can reject each with a message that names the
         // dataset and the fix, not a bare "unrecognized key".
         extends: placement.dataset.extends === 'native' ?
             z.array(z.string()).optional() :
             unlisted(z.unknown().optional()),
         abstract: placement.dataset.abstract === 'native' ?
             z.boolean().optional() :
             unlisted(z.unknown().optional()),
       })
          .strict()
          .superRefine((ds: any, ctx) => {
            if (placement.dataset.extends !== 'native' &&
                ds.extends !== undefined) {
              ctx.addIssue({
                code: 'custom',
                path: ['extends'],
                message: `dataset '${ds.name}': 'extends' is a ` +
                    `'${GOOGLE_VERSION}' extension. Set 'extends' in a ` +
                    `${GOOGLE_VENDOR} custom_extensions block on the ` +
                    `dataset, or set the document version to ` +
                    `'${GOOGLE_VERSION}'.`,
              });
            }
            if (placement.dataset.abstract !== 'native' &&
                ds.abstract !== undefined) {
              ctx.addIssue({
                code: 'custom',
                path: ['abstract'],
                message: `dataset '${ds.name}': 'abstract' is a ` +
                    `'${GOOGLE_VERSION}' extension. An abstract dataset has ` +
                    `no table, and every '${OSSIE_VERSION}' dataset needs a ` +
                    `'source'. A model that needs an abstract entity uses ` +
                    `'${GOOGLE_VERSION}'.`,
              });
            }
            const abstract =
                placement.dataset.abstract === 'native' && ds.abstract === true;
            // In the Google flavor, a concrete (non-abstract) dataset must name
            // its backing table; only an abstract one may omit `source`. Relaxed
            // under bindingOptional. Vanilla has no `abstract` and requires
            // `source` unconditionally (see requireVanillaBindings).
            if (extended && !bindingOptional && !abstract &&
                ds.source === undefined) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['source'],
                message: sourceRequiredMessage(ds.name),
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
                    `entity '${ds.name}': an abstract entity has no table; ` +
                    `remove 'source', or drop 'abstract: true' to bind it to that table`,
              });
            }
            // A field with no `expression` is unbound -- there is no separate
            // flag. One logical model serves several stores from different
            // profiles, so it is not a load error under either
            // `bindingOptional`. validateDeployments rejects one on a concrete
            // leaf entity when a graph deployment uses the model file's own
            // bindings. An `expression` with no SQL is an
            // error: it binds the field to nothing. A vanilla document's string
            // form is reported by convertExpression instead, since that form is
            // the first thing to fix.
            (ds.fields ?? []).forEach((f: any, i: number) => {
              if (!extended && typeof f.expression === 'string') return;
              const problem = noSqlProblem(f.expression, ds.name);
              if (problem) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  path: ['fields', i, 'expression'],
                  message: `field '${ds.name}.${f.name}': ${problem}; write ` +
                      `the field's SQL, or remove 'expression' to leave the ` +
                      `field unbound`,
                });
              }
            });
          });

  const relationship =
      z.object({
         name: z.string(),
         from: z.string(),
         to: z.string(),
         from_columns: z.array(z.string()).min(1).optional(),
         to_columns: z.array(z.string()).min(1).optional(),
         // Vanilla rejects a relationship's description after the schema.
         description: placement.relationship.description === 'native' ?
             z.string().optional() :
             unlisted(z.unknown().optional()),
         ai_context: aiContext.optional(),
         ...customExtensionsKey,
       })
          .strict()
          .superRefine((r, ctx) => {
            if ((r.from_columns === undefined) !==
                (r.to_columns === undefined)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: halfBoundJoinMessage(r.name),
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
         entity: placement.metric.entity === 'native' ?
             z.string().optional() :
             unlisted(z.unknown().optional()),
       })
          .strict()
          .superRefine((mt, ctx) => {
            // A metric's `expression` is required, so one with no SQL is an
            // error. A vanilla string form is reported as for a field.
            const problem = !extended && typeof mt.expression === 'string' ?
                undefined :
                noSqlProblem(mt.expression);
            if (problem) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['expression'],
                message: `metric '${mt.name}': ${problem}; write the ` +
                    `metric's SQL`,
              });
            }
            if (placement.metric.entity === 'native' ||
                mt.entity === undefined) {
              return;
            }
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['entity'],
              message: `metric '${mt.name}': 'entity' is a ` +
                  `'${GOOGLE_VERSION}' extension. A '${OSSIE_VERSION}' ` +
                  `metric takes its entity from the fields it reads, as in ` +
                  `'COUNT(orders.id)'. To anchor it explicitly, set 'entity' ` +
                  `in a ${GOOGLE_VENDOR} custom_extensions block on the ` +
                  `metric, or set the document version to ` +
                  `'${GOOGLE_VERSION}'.`,
            });
          });

  // The same shape the superset uses, closed to unknown keys. Restating it
  // here is what let the two disagree: a key added to one and not the other
  // parses in the loader's own type and is rejected by the document schema,
  // which reports it as an unrecognized key on a line the author just wrote
  // out of the guide.
  const parameter = parameterSchema.strict();

  const action = z.object({
                    name: z.string().min(1),
                    description: z.string().min(1).optional(),
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
                        name: z.string().min(1),
                        expression: unlisted(z.unknown().optional()),
                        judgment: z.string().optional(),
                        description: z.string().min(1).optional(),
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

  const modelExtensions = {
    ...(placement.model.deployments === 'native' ? {
      deployments: z.array(deploymentSchema).optional(),
    } :
                                                   {}),
    ...(placement.model.actions === 'native' ?
            {actions: z.array(action).optional()} :
            {}),
    ...(placement.model.constraints === 'native' ?
            {constraints: z.array(constraint).optional()} :
            {}),
  };
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
                   ...modelExtensions,
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
// is lost and a 1P round-trip stays lossless.
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


// The vendor tag for Google-specific extension blocks.
export const GOOGLE_VENDOR = 'GOOGLE';

// Rewrites the author-friendly sugar forms into the canonical wire shape the
// schema validates, and rejects deprecated or flavor-mismatched model keys up
// front with actionable messages: the removed `deployment_target:` key,
// inline `profiles:` in either flavor, and `deployments:` or
// `entities:` in vanilla. Under the extended profile, `entities:` is rewritten
// to `datasets:`. Operates on the parsed document before validation.
function normalizeDocumentSugars(doc: unknown, extended: boolean): unknown {
  if (!doc || typeof doc !== 'object') return doc;
  const cloned = structuredClone(doc) as any;
  const models = cloned.semantic_model;
  if (!Array.isArray(models)) return cloned;
  for (const m of models) {
    if (m && typeof m === 'object') {
      normalizeModelSugars(m, extended);
    }
  }
  return cloned;
}

function normalizeModelSugars(m: any, extended: boolean): void {
  const label = typeof m.name === 'string' ? `model '${m.name}'` : 'model';
  const placement =
      FORMAT_VERSION_PLACEMENT[extended ? GOOGLE_VERSION : OSSIE_VERSION];

  // `deployment_target` has been replaced by the named `deployments:` list in
  // the extended profile (and was never in vanilla).
  if (m.deployment_target !== undefined) {
    if (!extended) {
      throw new SemanticModelError(
          `Semantic model load error: ${label}: 'deployment_target' is not ` +
          `in the open format ('${OSSIE_VERSION}'); ` +
          `${DEPLOYMENTS_VERSION_HINT}`);
    }
    if (m.deployments !== undefined) {
      throw new SemanticModelError(
          `Semantic model load error: ${label}: 'deployment_target' is no ` +
          `longer supported; remove it, and list its target under ` +
          `'deployments' if it is not there already.`);
    }
    const target = typeof m.deployment_target === 'string' ?
        asResourceName(m.deployment_target) :
        '<target>';
    throw new SemanticModelError(
        `Semantic model load error: ${label}: 'deployment_target' is no ` +
        `longer supported; migrate to the named 'deployments' list:\n` +
        `  deployments:\n` +
        `    - name: default\n` +
        `      target: ${target}`);
  }

  if (placement.model.deployments !== 'native' && m.deployments !== undefined) {
    throw new SemanticModelError(
        `Semantic model load error: ${label}: 'deployments' is not in the ` +
        `open format ('${OSSIE_VERSION}'); ${DEPLOYMENTS_VERSION_HINT}`);
  }

  // In the Google flavor, binding profiles live in sidecar files
  // (`<model>.profile.<name>.yaml`); in vanilla they live in a GOOGLE
  // custom_extensions block on the model. Neither flavor takes a native
  // `profiles:` key on the model.
  if (m.profiles !== undefined) {
    const modelFile = typeof m.name === 'string' ? m.name : '<model>';
    if (placement.model.profiles === 'file') {
      throw new SemanticModelError(
          `Semantic model load error: ${label}: inline 'profiles' are not ` +
          `supported in a '${GOOGLE_VERSION}' document; write each binding ` +
          `profile in its own sidecar file ` +
          `'${modelFile}.profile.<name>.yaml'.`);
    }
    throw new SemanticModelError(
        `Semantic model load error: ${label}: 'profiles' is not in the ` +
        `open format ('${OSSIE_VERSION}'); list 'profiles' in a ` +
        `${GOOGLE_VENDOR} custom_extensions block on the model, or set ` +
        `version: '${GOOGLE_VERSION}' and write each binding profile in its ` +
        `own sidecar file '${modelFile}.profile.<name>.yaml'.`);
  }

  // `entities` is a native alias for `datasets`, accepted only under the
  // extended profile. Under vanilla Ossie the key is unknown; surface a clear
  // message here rather than the strict schema's generic "unrecognized key".
  if (m.entities !== undefined) {
    if (!extended) {
      throw new SemanticModelError(
          `Semantic model load error: ${label}: 'entities' is a ` +
          `'${GOOGLE_VERSION}' extension; use 'datasets', or set the document ` +
          `version to '${GOOGLE_VERSION}'.`);
    }
    if (m.datasets !== undefined) {
      throw new SemanticModelError(
          `Semantic model load error: ${label}: set either ` +
          `'entities' or 'datasets', not both (they are the same key).`);
    }
    m.datasets = m.entities;
    delete m.entities;
  }
}

// The levels a `custom_extensions` block may sit on.
type ExtensionLevel = 'model'|'dataset'|'field'|'relationship'|'metric';

// True when `vendorName` names the GOOGLE vendor, in any letter case.
export function isGoogleVendor(vendorName: unknown): boolean {
  return typeof vendorName === 'string' &&
      vendorName.toUpperCase() === GOOGLE_VENDOR;
}

// True when a block list names the GOOGLE vendor.
export function hasGoogleBlock(
    exts: ReadonlyArray<{vendor_name?: unknown}>|undefined): boolean {
  return !!exts?.some(e => isGoogleVendor(e.vendor_name));
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
  if (version === GOOGLE_VERSION && level === 'field') {
    throw new SemanticModelError(
        `Semantic model load error: ${ctx}: a '${GOOGLE_VENDOR}' ` +
        `custom_extensions block is not accepted on a field; the format ` +
        `defines no field-level ${GOOGLE_VENDOR} extension.`);
  }
  if (version === GOOGLE_VERSION) {
    throw new SemanticModelError(
        `Semantic model load error: ${ctx}: a '${GOOGLE_VENDOR}' ` +
        `custom_extensions block is not accepted in a '${GOOGLE_VERSION}' ` +
        `document. Everything it would carry is a native key in this ` +
        `flavor; write it as one.`);
  }
  if (level === 'field') {
    throw new SemanticModelError(
        `Semantic model load error: ${ctx}: a '${OSSIE_VERSION}' document ` +
        `cannot carry a '${GOOGLE_VENDOR}' custom_extensions block on a ` +
        `field; the format defines a ${GOOGLE_VENDOR} payload only on a ` +
        `model, dataset, relationship or metric.`);
  }
}

// The levels a GOOGLE block carries keys on.
type BlockLevel = Exclude<ExtensionLevel, 'field'>;

// How the Google flavor validates each block key. A profile is read
// as a profile file is instead (readBlockProfiles).
const GOOGLE_BLOCK_SCHEMAS: Record<string, z.ZodTypeAny> = {
  deployments: z.array(deploymentSchema),
  extends: z.array(z.string()),
  description: z.string(),
  entity: z.string(),
};

// What the GOOGLE blocks on one object of a vanilla document carry.
interface GoogleBlockValues {
  profiles?: ProfileSpec[];
  deployments?: Array<z.infer<typeof deploymentSchema>>;
  extends?: string[];
  description?: string;
  entity?: string;
}

// Reads the GOOGLE blocks among `exts`, the `custom_extensions` of the object
// `ctx` at `level`, and returns the values they carry and the blocks the object
// keeps. Only a vanilla document gives a GOOGLE block meaning, and
// rejectGoogleBlock rejects one in the Google flavor. Each key is validated as
// the Google flavor validates its native key, apart from `profiles`, whose
// entries are read as profile files are. A block that is read is not kept, so
// an object keeps its third-party blocks. Throws, naming the object, on data
// that is not a JSON object, a key one block sets twice, a key the level does
// not take, `abstract` included, a key two blocks both set, a value the Google
// flavor rejects, and a model's `deploymentTargets`, which `deployments`
// replaces.
function readGoogleBlocks(
    exts: CustomExtensionDoc[]|undefined, version: FormatVersion,
    level: BlockLevel, ctx: string):
    {values: GoogleBlockValues; kept?: CustomExtension[]} {
  rejectGoogleBlock(exts, version, level, ctx);
  const error = (problem: string) =>
      new SemanticModelError(`Semantic model load error: ${ctx}: ${problem}`);
  const block = `${GOOGLE_VENDOR} custom_extensions block`;
  const levelPlacement = FORMAT_VERSION_PLACEMENT[version][level] as
      Record<string, ConstructPlacement>;
  const values: Record<string, unknown> = {};
  const kept: CustomExtension[] = [];
  for (const e of exts ?? []) {
    if (!isGoogleVendor(e.vendor_name)) {
      kept.push({vendorName: e.vendor_name, data: e.data});
      continue;
    }
    let data: unknown;
    try {
      data = JSON.parse(e.data);
    } catch {
      // Reported below, as data that is not an object is.
    }
    if (!isRecord(data)) {
      throw error(`the 'data' of a ${block} must be a JSON object.`);
    }
    // JSON.parse keeps the last of a repeated key. The YAML a native key is
    // read from rejects a repeated key, so a block does too.
    if (setsAKeyTwice(e.data)) {
      throw error(
          `the 'data' of a ${block} sets a key twice; set each key once.`);
    }
    for (const [key, value] of Object.entries(data)) {
      if (level === 'model' && key === 'deploymentTargets') {
        throw error(
            `'${key}' is no longer supported; use 'deployments' inside the ` +
            `${block} instead, for example ` +
            `{"deployments": [{"name": "default", "target": "<target>"}]}.`);
      }
      if (level === 'dataset' && key === 'abstract') {
        throw error(
            `a ${block} cannot declare 'abstract' in a '${OSSIE_VERSION}' ` +
            `document. An abstract dataset has no table, and every ` +
            `'${OSSIE_VERSION}' dataset needs a 'source'. A model that needs ` +
            `an abstract entity uses '${GOOGLE_VERSION}'.`);
      }
      const allowed = Object.keys(levelPlacement)
                          .filter(k => levelPlacement[k] === 'block');
      if (!allowed.includes(key)) {
        throw error(
            `'${key}' is not a key a ${block} takes on a ${level}; it takes ` +
            `${allowed.map(k => `'${k}'`).join(' and ')}.`);
      }
      if (Object.hasOwn(values, key)) {
        throw error(
            `two ${block}s both set '${key}'; set it in one block` +
            (key === 'extends' ? `, listing every parent there.` : `.`));
      }
      if (key === 'profiles') {
        values.profiles = readBlockProfiles(value, error, ctx);
        continue;
      }
      const parsed = GOOGLE_BLOCK_SCHEMAS[key].safeParse(value);
      if (!parsed.success) {
        throw error(keyProblems(
            parsed.error, GOOGLE_BLOCK_SCHEMAS[key], key, value,
            `the ${block}`).replaceAll('\n', `\n${ctx}: `));
      }
      values[key] = parsed.data;
    }
  }
  return {
    values: values as GoogleBlockValues,
    kept: kept.length ? kept : undefined,
  };
}

// Reads a GOOGLE block's `profiles`: a list of profiles, each read as a profile
// file is. A name follows the rules the layout gives a profile file's name: it
// passes the profile rule in names.ts, it is not `default` in any letter case,
// and no two names are equal ignoring case.
function readBlockProfiles(
    value: unknown, error: (problem: string) => SemanticModelError,
    ctx: string): ProfileSpec[] {
  const block = `${GOOGLE_VENDOR} custom_extensions block`;
  if (!Array.isArray(value)) {
    throw error(`'profiles' in a ${block} must be a list.`);
  }
  const profiles = value.map(p => {
    if (!isRecord(p) || typeof p.name !== 'string') {
      throw error(
          `each profile in a ${block} must be a mapping with a 'name'.`);
    }
    if (nameProblem('profile', p.name)) {
      throw error(
          `profile name '${p.name}' in a ${block} is not valid; a profile ` +
          `name is a letter followed by up to 499 letters, digits, ` +
          `underscores and hyphens.`);
    }
    if (p.name.toLowerCase() === DEFAULT_PROFILE) {
      throw error(
          `a profile in a ${block} may not be named '${p.name}'; ` +
          `'${DEFAULT_PROFILE}' names the model's inline bindings.`);
    }
    // profileSpecOf rejects these two keys too, in words about a profile file.
    for (const key of ['version', 'semantic_model']) {
      if (p[key] !== undefined) {
        throw error(
            `profile '${p.name}' in a ${block} sets '${key}', which a ` +
            `profile may not set.`);
      }
    }
    try {
      return profileSpecOf(p, p.name);
    } catch (err) {
      if (!(err instanceof SemanticModelError)) throw err;
      throw error(err.message);
    }
  });
  rejectDuplicateNames(profiles.map(p => p.name), 'profile name', ctx);
  const byLowerName = new Map<string, string>();
  for (const {name} of profiles) {
    const twin = byLowerName.get(name.toLowerCase());
    if (twin !== undefined) {
      throw error(
          `profiles '${twin}' and '${name}' in a ${block} name the same ` +
          `profile; profile names are unique ignoring case.`);
    }
    byLowerName.set(name.toLowerCase(), name);
  }
  return profiles;
}

// Whether the JSON text `data` sets a key twice.
export function setsAKeyTwice(data: string): boolean {
  return yaml.parseDocument(data, YAML_OPTIONS)
      .errors.some(err => err.code === 'DUPLICATE_KEY');
}

// Whether the JSON text `data` sets `profiles` twice, or sets a key twice
// inside its profiles.
function setsAProfilesKeyTwice(data: string): boolean {
  const doc = yaml.parseDocument(data, YAML_OPTIONS);
  if (!yaml.isMap(doc.contents)) return false;
  const pairs = doc.contents.items.filter(
      p => yaml.isScalar(p.key) && p.key.value === 'profiles');
  const range = yaml.isNode(pairs[0]?.value) ? pairs[0].value.range : undefined;
  return pairs.length > 1 ||
      (!!range && setsAKeyTwice(data.slice(range[0], range[1])));
}

// `v` as a list: a list as it is, one value as a list of it, and nothing as an
// empty list.
function asList(v: unknown): unknown[] {
  return Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
}

// The profiles the GOOGLE block `e` lists, whatever its shape: in data written
// as a JSON string or as a YAML mapping, or beside `vendor_name` with no data.
// `json` is them as the data of a block that lists only them. 'none' when the
// block lists no profiles. 'unread' when it has neither data nor profiles
// beside `vendor_name`, when its data is not a JSON object, or when its
// profiles have no JSON form, as with a recursive alias.
function listedProfiles(e: Record<string, unknown>): {json: string}|'none'|
    'unread' {
  if (e.data == null && e.profiles === undefined) return 'unread';
  let data: unknown = e.data == null ? {profiles: e.profiles} : e.data;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return 'unread';
    }
  }
  if (!isRecord(data)) return 'unread';
  if (data.profiles === undefined) return 'none';
  try {
    return {json: JSON.stringify({profiles: data.profiles})};
  } catch {
    return 'unread';
  }
}

/**
 * The profiles the model in a vanilla document carries in its GOOGLE blocks,
 * read as a load reads them, without loading the rest of the model. So a
 * caller finds a profile even in a model that does not load, as it finds a
 * profile file. Only the profiles in the model's GOOGLE blocks are read, and
 * the load reports a problem with any other key. Empty for a document that is
 * not a vanilla model.
 *
 * A profile's field binding that is not blank needs the SQL parser, so call
 * `loadSqlEngine()` first. Without it, this throws the parser's plain Error.
 *
 * A GOOGLE block whose shape the load rejects is read too, and the load
 * reports its shape. Its profiles may be in data written as a JSON string or
 * as a YAML mapping, or listed beside `vendor_name` with no data. Throws
 * SemanticModelError on profiles a load rejects, on data that sets `profiles`
 * twice or a key twice inside them, and on data that is not a JSON object in
 * a block whose shape the load accepts.
 *
 * Text that is not valid YAML is read as far as it parses. A document whose
 * root keys are all strings, and that sets `version` once, to a string other
 * than the vanilla one, gives none when each YAML error is a key set twice, an
 * alias whose anchor is not set, or more aliases than a load expands. Otherwise
 * its profiles are read as in text that parses, and only when that reading is
 * unambiguous. Each YAML error is a key set twice or an alias whose anchor is
 * not set, since any other error, such as a bad indent, can move the blocks,
 * cut them short or change the version. The document sets `version` once, to
 * the vanilla one, and `semantic_model` at most once. Its model sets
 * `custom_extensions` at most once, and each block that is a mapping sets
 * `vendor_name` once, to a string. A GOOGLE block sets `data` and `profiles` at
 * most once each, and holds no alias. Every key of a mapping on that path is a
 * string, so not an alias or a merge key, and no value on it is an alias. No
 * key is set twice inside `custom_extensions`. When any of these fails, when a
 * GOOGLE block cannot be read, or when a load rejects its profiles, it throws
 * the error a load reports for the text. So does a vanilla model whose text has
 * more aliases than a load expands, or a merge key whose value is not a
 * mapping.
 */
export function googleBlockProfiles(text: string): ProfileSpec[] {
  let doc: unknown;
  try {
    doc = yaml.parse(text, YAML_OPTIONS);
  } catch (err: any) {
    return googleBlockProfilesPastYamlError(text, yamlErrorMessage(err, text));
  }
  return blockProfilesOf(doc);
}

// The profiles in the GOOGLE blocks of the model in the parsed document `doc`,
// read as googleBlockProfiles reads text that parses. When `unreadable` is
// set, a GOOGLE block whose profiles cannot be read throws it.
function blockProfilesOf(
    doc: unknown, unreadable?: SemanticModelError): ProfileSpec[] {
  if (!isRecord(doc) || doc.version !== OSSIE_VERSION) return [];
  // The load rejects a `semantic_model` written as one mapping, and reports it.
  const m = asList(doc.semantic_model)[0];
  if (!isRecord(m)) return [];
  const blocks: CustomExtensionDoc[] = [];
  // The load rejects a `custom_extensions` written as one mapping, and reports
  // it. The mapping is read as one block.
  for (const e of asList(m.custom_extensions)) {
    if (!isRecord(e) || !isGoogleVendor(e.vendor_name)) continue;
    const ext = customExtensionSchema.safeParse(e);
    const listed = listedProfiles(e);
    if (listed === 'unread' && unreadable) throw unreadable;
    if (typeof listed === 'object') {
      // Data that sets `profiles` twice, or a key twice inside them, is
      // rejected as for any block.
      const data =
          typeof e.data === 'string' && setsAProfilesKeyTwice(e.data) ?
          e.data :
          listed.json;
      blocks.push({vendor_name: GOOGLE_VENDOR, data});
    } else if (listed === 'unread' && ext.success) {
      // Data that is not a JSON object, rejected as for any block.
      blocks.push(ext.data);
    }
  }
  const label = typeof m.name === 'string' ? `model '${m.name}'` : 'model';
  return readGoogleBlocks(blocks, OSSIE_VERSION, 'model', label)
             .values.profiles ??
      [];
}

// The profiles the model in a vanilla document carries in its GOOGLE blocks,
// when its text is not valid YAML. `parseError` is the error a load reports
// for the text. A document whose version is read past the error as another
// version gives none (see versionPastYamlError). Otherwise the profiles are
// read as in text that parses, when that reading is unambiguous (see
// blocksReadOneWay). When it is not, when a GOOGLE block cannot be read, or
// when a load rejects its profiles, throws the load's error for the text.
function googleBlockProfilesPastYamlError(
    text: string, parseError: string): ProfileSpec[] {
  const yamlError = new SemanticModelError(
      `Semantic model load error: could not parse input: ${parseError}`);
  // An alias whose anchor is not set stays an alias here, so the checks see
  // it.
  const parsed = yaml.parseDocument(text, {...YAML_OPTIONS, uniqueKeys: false});
  const errors = yaml.parseDocument(text, YAML_OPTIONS).errors;
  const version = versionPastYamlError(parsed, errors);
  if (version !== undefined && version !== OSSIE_VERSION) return [];
  if (version === undefined || !blocksReadOneWay(parsed, errors)) {
    throw yamlError;
  }
  let doc: unknown;
  try {
    doc = parseLeniently(text).toJS();
  } catch {
    // More aliases than a load expands, or a merge key whose value is not a
    // mapping.
    throw yamlError;
  }
  try {
    return blockProfilesOf(doc, yamlError);
  } catch (err) {
    if (err instanceof SemanticModelError) throw yamlError;
    throw err;
  }
}

/**
 * The `version` the model document `text` sets, as googleBlockProfiles reads
 * it. Valid YAML gives its version. Past a YAML error, the version is read
 * only when every root key is a string and the root sets `version` once, to a
 * string. Each error must be a key set twice, an alias whose anchor is not
 * set, or more aliases than a load expands. Undefined otherwise, and when the
 * text sets no string version.
 */
export function modelDocumentVersion(text: string): string|undefined {
  let doc: unknown;
  try {
    doc = yaml.parse(text, YAML_OPTIONS);
  } catch {
    return versionPastYamlError(
        yaml.parseDocument(text, {...YAML_OPTIONS, uniqueKeys: false}),
        yaml.parseDocument(text, YAML_OPTIONS).errors);
  }
  return isRecord(doc) && typeof doc.version === 'string' ? doc.version :
                                                             undefined;
}

// The value of `key` in `node`, read past a YAML error: undefined when `node`
// is not a mapping, does not set `key`, or writes `key` with no colon, as in
// `{data}`, and null when the mapping has a key that is not a string, such as
// an alias or a merge key, sets `key` twice, or gives it an alias.
function onlyValue(node: unknown, key: string): unknown {
  if (!yaml.isMap(node)) return undefined;
  if (!node.items.every(
          p => yaml.isScalar(p.key) && typeof p.key.value === 'string')) {
    return null;
  }
  const pairs = node.items.filter(p => (p.key as yaml.Scalar).value === key);
  if (pairs.length > 1 || yaml.isAlias(pairs[0]?.value)) return null;
  return pairs[0]?.value ?? undefined;
}

// The version a model document sets, read past a YAML error. `parsed` is the
// text parsed with keys set twice allowed, and `errors` are the errors of the
// strict parse. The version is read only when each error is a key set twice,
// every root key is a string, and the root sets `version` once, to a string.
// Any other YAML error can change the version or hide a second one.
function versionPastYamlError(
    parsed: yaml.Document.Parsed, errors: yaml.YAMLError[]): string|undefined {
  const version = onlyValue(parsed.contents, 'version');
  if (!yaml.isScalar(version) || typeof version.value !== 'string' ||
      errors.some(err => err.code !== 'DUPLICATE_KEY')) {
    return undefined;
  }
  return version.value;
}

// Whether a text that is not valid YAML gives one reading of its model's GOOGLE
// blocks. `parsed` is the text parsed with keys set twice allowed, and `errors`
// are the errors of the strict parse, each a key set twice. The document sets
// `semantic_model` at most once, its first model sets `custom_extensions` at
// most once, and each block that is a mapping sets `vendor_name` once, to a
// string. A GOOGLE block sets `data` and `profiles` at most once each, and
// holds no alias, since an alias may name an anchor set on a key set twice.
// Every key of a mapping on that path is a string, so not an alias or a merge
// key, and no value on it is an alias. No key is set twice inside
// `custom_extensions`.
function blocksReadOneWay(
    parsed: yaml.Document.Parsed, errors: yaml.YAMLError[]): boolean {
  const models = onlyValue(parsed.contents, 'semantic_model');
  if (models === null) return false;
  const model = yaml.isSeq(models) ? models.items[0] : models;
  if (yaml.isAlias(model)) return false;
  const exts = onlyValue(model, 'custom_extensions');
  if (exts === null) return false;
  if (!yaml.isNode(exts)) return true;
  const [start, , end] = exts.range ?? [0, 0, 0];
  if (errors.some(err => err.pos[0] >= start && err.pos[0] < end)) {
    return false;
  }
  for (const block of yaml.isSeq(exts) ? exts.items : [exts]) {
    if (yaml.isAlias(block)) return false;
    if (!yaml.isMap(block)) continue;
    const vendor = onlyValue(block, 'vendor_name');
    if (!yaml.isScalar(vendor) || typeof vendor.value !== 'string') {
      return false;
    }
    if (!isGoogleVendor(vendor.value)) continue;
    if (onlyValue(block, 'data') === null ||
        onlyValue(block, 'profiles') === null || holdsAlias(block)) {
      return false;
    }
  }
  return true;
}

// Whether `node` holds an alias, as a key or a value at any depth.
function holdsAlias(node: yaml.Node): boolean {
  let found = false;
  yaml.visit(node, {
    Alias: () => {
      found = true;
      return yaml.visit.BREAK;
    },
  });
  return found;
}

// Ossie's Relationship has no `description` key and its objects are closed, so
// a vanilla document that writes one is no longer valid Ossie. The description
// is still expressible there, inside a GOOGLE block; say so, with the notation.
function rejectVanillaRelationshipDescription(
    r: RelationshipDoc, version: FormatVersion): void {
  if (FORMAT_VERSION_PLACEMENT[version].relationship.description === 'native' ||
      r.description === undefined) {
    return;
  }
  throw new SemanticModelError(
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
    throw new SemanticModelError(
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

export function isRecord(v: unknown): v is Record<string, any> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Each model, entity, field, relationship and metric in a parsed document
// that carries an `ai_context`, with the label errors use for it, in the words
// of a model of `version`. Runs before schema validation, so it skips anything
// not shaped as expected.
export function*
    modelAiContexts(doc: unknown, version?: FormatVersion):
        Generator<{ai: Record<string, unknown>; label: string}> {
  const list = (v: unknown) => (Array.isArray(v) ? v : []);
  const named = (kind: string, name: unknown) =>
      typeof name === 'string' ? `${kind} '${name}'` : kind;
  const models = isRecord(doc) ? list(doc.semantic_model) : [];
  for (const m of models) {
    if (!isRecord(m)) continue;
    if (isRecord(m.ai_context)) {
      yield {ai: m.ai_context, label: named('model', m.name)};
    }
    for (const ds of [...list(m.datasets), ...list(m.entities)]) {
      if (!isRecord(ds)) continue;
      if (isRecord(ds.ai_context)) {
        yield {ai: ds.ai_context, label: named(entityWord(version), ds.name)};
      }
      for (const f of list(ds.fields)) {
        if (!isRecord(f) || !isRecord(f.ai_context)) continue;
        const label = typeof f.name === 'string' && typeof ds.name === 'string' ?
            `field '${ds.name}.${f.name}'` :
            'field';
        yield {ai: f.ai_context, label};
      }
    }
    for (const [items, kind] of [
           [m.relationships, 'relationship'], [m.metrics, 'metric'],
         ] as const) {
      for (const it of list(items)) {
        if (isRecord(it) && isRecord(it.ai_context)) {
          yield {ai: it.ai_context, label: named(kind, it.name)};
        }
      }
    }
  }
}

// Why a custom ai_context member named `__proto__` cannot load, or undefined.
// Schema validation drops that key as a guard against prototype pollution, so
// it is rejected here rather than lost without a word. Only member names are
// checked: a member's value is opaque and keeps any key. In the Google flavor
// a sibling of the standard members is an unrecognized key rather than a
// custom member. The message names its object in the words of a model of
// `words`.
function protoMemberError(
    doc: unknown, google: boolean, words: FormatVersion): string|undefined {
  const custom = (label: string) =>
      `${label}: custom ai_context member '__proto__' is not supported; ` +
      `rename it.`;
  for (const {ai, label} of modelAiContexts(doc, words)) {
    if (google && isRecord(ai.custom) && Object.hasOwn(ai.custom, '__proto__')) {
      return custom(label);
    }
    if (Object.hasOwn(ai, '__proto__')) {
      return google ?
          `${label}: ai_context has an unrecognized key '__proto__'.` :
          custom(label);
    }
  }
  return undefined;
}

/**
 * Loads YAML or JSON text (a document in the AI-first semantics format) into
 * the Semantic Model IR. `yaml.parse` accepts JSON too, so both are supported.
 *
 * A document with a field or metric expression that is not blank needs the SQL
 * parser, so call `loadSqlEngine()` first. Without it, this throws a plain
 * Error instead of a SemanticModelError.
 */
export function loadModels(text: string, opts: LoadOptions = {}): LoadResult {
  let doc: unknown;
  try {
    doc = yaml.parse(text, YAML_OPTIONS);
  } catch (err: any) {
    throw new SemanticModelError(
        `Semantic model load error: could not parse input: ${
            yamlErrorMessage(err, text)}`);
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
  const proto =
      protoMemberError(doc, extended, opts.messageFlavor ?? version);
  if (proto) {
    throw new SemanticModelError(`Semantic model load error: ${proto}`);
  }

  const normalized = normalizeDocumentSugars(doc, extended);
  const schema = makeDocumentSchema(opts.bindingOptional ?? false, extended);
  const result = schema.safeParse(normalized);
  if (!result.success) {
    throw new SemanticModelError(`Semantic model load error: ${
        schemaProblems(result.error.issues, {
          schema, doc: normalized, authored: doc, extended,
          subject: 'the document', words: opts.messageFlavor,
        })}`);
  }

  const warnings: string[] = [];
  const parsed = result.data as DocumentDoc;

  const models = parsed.semantic_model.map(
      m => convertModel(m, version, opts, warnings));
  return {models, warnings: [...new Set(warnings)]};
}

// Whether a dialect list takes its ANSI_SQL text for want of one in
// `preferred`. pickDialect picks by this and expressionWarning reads it, so
// the two cannot disagree.
function fallsBackToAnsi(
    dialects: ReadonlyArray<{dialect: string}>, preferred: string): boolean {
  return !dialects.some(d => d.dialect === preferred.toUpperCase()) &&
      dialects.some(d => d.dialect === FALLBACK_DIALECT);
}

// The table dialects whose database reads a double-quoted token as a string,
// as hasDoubleQuotedColumn finds it, each with that database's name for a
// message. Every other dialect reads it as a name.
const DOUBLE_QUOTES_AS_TEXT: Record<string, string> = {
  BIGQUERY: 'BigQuery',
  SPANNER: 'Spanner',
  MYSQL: 'MySQL',
  DATABRICKS: 'Databricks',
};

// A field or metric as a warning names it in `ctx`, in `model`, whose
// document push's messages name `document`, with what the import the advice
// to add a BigQuery text suggests gives in `outcomes`. A metric reads fields
// as `entity.field`.
interface Subject {
  ctx: string;
  metric: boolean;
  model: Pick<SemanticModel, 'entities'|'version'|'thirdPartyImport'>;
  document: string;
  outcomes?: TranspileOutcomes;
}

// The warning `item` gives on a table of `dialect`, in capitals, or undefined
// when it has text in that dialect. That is the double-quote warning on a
// dialect in DOUBLE_QUOTES_AS_TEXT, and otherwise the warning that it has no
// text the `preferred` dialect runs, ending with importHint's advice. Only that
// dialect gives it, and never for the string form. An ANSI_SQL text runs on
// every table, so it gives none.
function expressionWarning(
    item: Pick<
        Field,
        'expression'|'dialects'|'stringForm'|'importedExpression'|
        'importedDialect'>,
    subject: Subject, dialect: string, preferred: string): string|undefined {
  const {ctx} = subject;
  const dialects = item.dialects ?? [];
  if (!dialects.length) return undefined;
  if (dialects.some(d => d.dialect === dialect)) return undefined;
  const ansi = dialects.find(d => d.dialect === FALLBACK_DIALECT);
  const database = DOUBLE_QUOTES_AS_TEXT[dialect];
  if (ansi && database && hasDoubleQuotedColumn(ansi.expression)) {
    const names = doubleQuotedNames(ansi.expression);
    const reads = `${ctx}: ${database} reads ${
        listed(names.map(n => `"${n}"`))} in its '${
        FALLBACK_DIALECT}' expression as text; `;
    if (subject.metric) {
      const several = names.length > 1;
      return reads + `if you meant ${several ? 'fields' : 'a field'}, give ` +
          `it a '${dialect}' expression that names ${
                 several ? 'each' : 'it'} as '<entity>.<field>'`;
    }
    return reads + `if you meant a column or a field, give it a '${
               dialect}' expression that names a column alone, in backticks ` +
        `if it needs quoting, and a field of the entity whose fields list ` +
        `holds this expression as '<entity>.<field>'`;
  }
  if (item.stringForm || dialect !== preferred.toUpperCase()) return undefined;
  if (fallsBackToAnsi(dialects, preferred)) return undefined;
  const vendor = dialects.find(d => d.dialect !== FALLBACK_DIALECT);
  return `${ctx}: no '${preferred}' or '${FALLBACK_DIALECT}' dialect, so a ${
             preferred} table cannot run its '${vendor?.dialect}' expression${
      importHint(
          item, preferred.toUpperCase(), subject.model, subject.document,
          subject.outcomes)}`;
}

// Whether `entity`'s table runs SQL in `dialect`. An abstract entity runs
// none, and so does one whose table's dialect the load does not know.
function runsDialect(
    entity: Pick<Entity, 'abstract'|'authoredSource'|'dataSource'|'sourceDialect'>,
    dialect: string): boolean {
  return sourcesDialect({entities: [entity]}) === dialect.toUpperCase();
}

// The warning `item` gives on `table`, the table of `entity`:
// expressionWarning's when the load knows the table's dialect, or one saying
// the table has no text to run. With `textChecked`, the second is given only
// on a Cloud SQL, Spanner or third-party table no lookup has read. On a table
// of the `preferred` dialect, expressionWarning's warning already says so.
function tableWarning(
    item: Pick<
        Field,
        'expression'|'dialects'|'stringForm'|'importedExpression'|
        'importedDialect'>,
    subject: Subject, table: TableDialects, entity: string, preferred: string,
    textChecked: boolean): string|undefined {
  const w = table.unread ?
      undefined :
      expressionWarning(item, subject, table.name, preferred);
  if (w || (textChecked && !table.unread && !table.guessed) ||
      !noTextFor(item, table.dialects)) {
    return w;
  }
  const own = table.dialects.map(d => `'${d}'`).join(', ');
  return `${subject.ctx}: no ${own} or '${FALLBACK_DIALECT}' dialect, so the ${
             table.name} table of entity '${entity}' cannot run it`;
}

// The warning each field's expression gives on each entity whose table
// tableDialects gives. An inherited field is judged on each entity that
// inherits it, and named after that entity.
function fieldWarnings(
    model: SemanticModel, preferred: string, textChecked: boolean,
    document: string, outcomes?: TranspileOutcomes): string[] {
  return fieldsOnTables(model, true)
      .map(({entity: e, field: f, table}) => tableWarning(
               f, {
                 ctx: `field '${e.name}.${f.name}'`,
                 metric: false,
                 model,
                 document,
                 outcomes,
               },
               table, e.name, preferred, textChecked))
      .filter((w): w is string => w !== undefined);
}

// The warning `metric`'s expression gives on the tables of the entities
// metricTableEntities gives, in that order. On a table of the `preferred`
// dialect it is expressionWarning's; otherwise it is the first tableWarning a
// table gives.
function metricWarning(
    metric: Pick<
        Metric,
        'name'|'authoredEntity'|'expression'|'dialects'|'stringForm'|
        'importedExpression'|'importedDialect'>,
    model: Pick<SemanticModel, 'version'|'thirdPartyImport'>&
    {entities: Entity[]},
    preferred: string, impliedDialect: string|null|undefined, document: string,
    outcomes?: TranspileOutcomes): string|undefined {
  const entities = model.entities;
  const subject =
      {ctx: `metric '${metric.name}'`, metric: true, model, document, outcomes};
  const names = metricTableEntities(
      metric, entities.map(e => e.name), preferred, impliedDialect);
  const tables =
      entities.filter(e => names.includes(e.name))
          .sort((a, b) => names.indexOf(a.name) - names.indexOf(b.name));
  if (tables.some(e => runsDialect(e, preferred))) {
    return expressionWarning(
        metric, subject, preferred.toUpperCase(), preferred);
  }
  for (const e of tables) {
    const table = tableDialects(e, true);
    const w = table &&
        tableWarning(metric, subject, table, e.name, preferred, false);
    if (w) return w;
  }
  return undefined;
}

// Infers the entities a metric's expressions reach across all dialect entries,
// and returns the warning the metric gives when an expression could not be
// parsed or when it states no `entity` and its expressions name none. An
// authored anchor, which vanilla writes in a GOOGLE block, settles which entity
// the metric belongs to, so a `COUNT(*)` with one is not warned about. An
// ANSI_SQL text whose `impliedDialect` no lookup read (null) is read as
// generic SQL, the closest reading there is.
export function inferMetricEntities(
    metric: Pick<
        Metric,
        'name'|'authoredEntity'|'expression'|'importedExpression'|
        'importedDialect'|'dialects'>,
    entityNames: string[], preferred: string = DEFAULT_DIALECT,
    impliedDialect?: string|null, version?: FormatVersion):
    {referenced: string[]; warning?: string} {
  const ctx = `metric '${metric.name}'`;
  const sources: Array<{text: string; dialect: string}> =
      (metric.dialects ?? [])
          .map(d => ({text: d.expression, dialect: d.dialect}));
  if (!sources.length) {
    const text = metric.expression ?? metric.importedExpression ?? '';
    const dialect = metric.expression !== undefined ?
        preferred :
        (metric.importedDialect ?? preferred);
    if (text) sources.push({text, dialect});
  }
  const allCols: SqlColumn[] = [];
  let unparsed = false;
  for (const {text, dialect} of sources) {
    if (!text) continue;
    const cols = columnsForSource(text, dialect, impliedDialect ?? undefined);
    if (cols === undefined) {
      unparsed = true;
    } else {
      allCols.push(...cols);
    }
  }
  const referenced = entitiesReached(allCols, entityNames);
  if (metric.authoredEntity === undefined && !referenced.length) {
    const entityHint = version === OSSIE_VERSION ?
        `set 'entity' in a ${GOOGLE_VENDOR} custom_extensions block on the ` +
            `metric, or use version '${GOOGLE_VERSION}' and set 'entity' on ` +
            `the metric` :
        `set 'entity' on the metric`;
    return {
      referenced,
      warning: unparsed ?
          `${ctx}: expression could not be parsed; entity inference was ` +
              `skipped (${entityHint}, or backtick-quote a reserved ` +
              `qualifier, such as \`Date\`.amount)` :
          `${ctx}: expression references no known entity; ` +
              `it may not be placeable downstream`,
    };
  }
  return {referenced};
}

// The entities whose tables run `metric`, of those named in `entityNames`: its
// authored anchor, then each entity inferMetricEntities finds its expressions
// reach. When it names none of them, every one in `entityNames`.
export function metricTableEntities(
    metric: Parameters<typeof inferMetricEntities>[0], entityNames: string[],
    preferred: string = DEFAULT_DIALECT,
    impliedDialect?: string|null): string[] {
  const {referenced} =
      inferMetricEntities(metric, entityNames, preferred, impliedDialect);
  const named = [...new Set([metric.authoredEntity, ...referenced])].filter(
      (n): n is string => n !== undefined && entityNames.includes(n));
  return named.length ? named : entityNames;
}

// Every warning a load gives about `model`'s entities and metrics, in the
// order a load gives them: each field's expression warning, then each metric's
// expression warning and its warning when it names no entity. A metric a
// profile excludes gives none. `textChecked` is LoadOptions.fieldTextChecked,
// and `document` and `outcomes` are LoadOptions.document and
// LoadOptions.transpileOutcomes. A profile changes only these; a load's other
// warnings, about actions, come after them.
export function entityAndMetricWarnings(
    model: SemanticModel, preferred: string = DEFAULT_DIALECT,
    textChecked = false, document = model.name,
    outcomes?: TranspileOutcomes): string[] {
  const entities = model.entities ?? [];
  const out = fieldWarnings(model, preferred, textChecked, document, outcomes);
  const entityNames = entities.map(e => e.name);
  const impliedDialect = sourcesDialect(model);
  const excluded = new Set(model.excludedMetrics);
  for (const m of model.metrics ?? []) {
    if (excluded.has(m.name)) continue;
    const {warning: mw} = inferMetricEntities(
        m, entityNames, preferred, impliedDialect, model.version);
    const w = metricWarning(
        m, {...model, entities}, preferred, impliedDialect, document, outcomes);
    if (w) out.push(w);
    if (mw) out.push(mw);
  }
  return [...new Set(out)];
}

// Reads and validates the top-level `version`. It is REQUIRED and must be one
// of the accepted values: the version selects which extension surface is legal,
// so it cannot be guessed, and a missing or unrecognized version is a hard load
// error rather than a warning (agreed with Dmitri).
function readVersion(doc: unknown): FormatVersion {
  const version =
      (doc && typeof doc === 'object') ? (doc as any).version : undefined;
  if (typeof version !== 'string' || version.length === 0) {
    throw new SemanticModelError(
        `Semantic model load error: missing 'version'; declare ` +
        `'${OSSIE_VERSION}' (vanilla Ossie) or '${GOOGLE_VERSION}' (the ` +
        `extended profile) at the top level.`);
  }
  if (!isFormatVersion(version)) {
    throw new SemanticModelError(
        `Semantic model load error: unknown version ` +
        `'${version}'; expected '${OSSIE_VERSION}' or '${GOOGLE_VERSION}'.`);
  }
  return version;
}


// Rejects names that appear more than once within a scope. Uniqueness is
// required for a valid graph: a duplicate dataset, field, metric, or
// relationship name makes the generated nodes, properties, or edges ambiguous,
// so a duplicate is a hard load error (agreed with Dmitri) rather than a
// warning. With `ignoreCase`, two names that differ only in case are rejected
// too, naming the first-seen spelling.
function rejectDuplicateNames(
    names: string[], kind: string, scope: string, ignoreCase = false): void {
  const seen = new Map<string, string>();
  for (const n of names) {
    const key = ignoreCase ? n.toLowerCase() : n;
    const first = seen.get(key);
    if (first !== undefined) {
      const collision =
          first === n ? '' : ` (case-insensitive collision with '${first}')`;
      throw new SemanticModelError(`${scope}: duplicate ${kind} '${n}'${
          collision}; names must be unique.`);
    }
    seen.set(key, n);
  }
}

// Rejects a name that breaks its kind's pattern or length limit (see
// names.ts), naming the scope it is in when one is given.
function rejectInvalidName(kind: NameKind, name: string, scope?: string): void {
  const problem = nameProblem(kind, name);
  if (problem) {
    throw new SemanticModelError(scope ? `${scope}: ${problem}` : problem);
  }
}

function convertModel(
    m: ModelDoc, version: FormatVersion, opts: LoadOptions,
    warnings: string[]): SemanticModel {
  const dialect = opts.dialect ?? DEFAULT_DIALECT;
  const word = entityWord(opts.messageFlavor ?? version);
  rejectInvalidName('model', m.name);

  const block = readGoogleBlocks(
      m.custom_extensions, version, 'model', `model '${m.name}'`);
  // A dataset's GOOGLE blocks are read before the bindings are checked, so a
  // dataset that declares `abstract` in one is told that vanilla has no
  // abstract dataset, even when it names no `source`.
  const datasetBlocks = m.datasets.map(
      ds => readGoogleBlocks(
          ds.custom_extensions, version, 'dataset', `${word} '${ds.name}'`));
  if (version === OSSIE_VERSION) {
    requireVanillaBindings(m);
  }

  const entities = m.datasets.map(
      (ds, i) => convertDataset(
          ds, datasetBlocks[i], version, opts, warnings, dialect, word));
  rejectDuplicateNames(
      entities.map(e => e.name), `${word} name`, `model '${m.name}'`, true);

  const entityNames = entities.map(e => e.name);
  const entityNameSet = new Set(entityNames);

  const relationships = (m.relationships ?? []).map(
      r => convertRelationship(r, version, entityNameSet, word));
  rejectDuplicateNames(
      relationships.map(r => r.name), 'relationship name', `model '${m.name}'`,
      true);

  // A field is judged on each entity that inherits it too, so its warning
  // waits until every entity is read.
  const document = opts.document ?? m.name;
  warnings.push(...fieldWarnings(
      {name: m.name, version, entities, relationships, metrics: [],
       thirdPartyImport: opts.thirdPartyImport},
      dialect, !!opts.fieldTextChecked, document, opts.transpileOutcomes));
  const impliedDialect = sourcesDialect({entities});
  const metrics = (m.metrics ?? []).map(
      mt => convertMetric(
          mt, version, entities, warnings, dialect, word, impliedDialect,
          opts.thirdPartyImport, document, opts.transpileOutcomes));
  rejectDuplicateNames(
      metrics.map(mt => mt.name), 'metric name', `model '${m.name}'`, true);

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
  const inheritedProblem = inheritanceResolved ?
      inheritedNoSqlProblems(entities, concepts)[0] :
      undefined;
  if (inheritedProblem) {
    throw new SemanticModelError(`Semantic model load error: model '${
        m.name}': ${inheritedProblem}`);
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

  const deploymentDocs = m.deployments ?? block.values.deployments ?? [];
  for (const d of deploymentDocs) {
    rejectInvalidName('deployment', d.name, `model '${m.name}'`);
  }
  const deployments = deploymentDocs.map(d => ({
    name: d.name,
    target: d.target,
    ...(d.profile !== undefined ? {profile: d.profile} : {}),
  }));
  rejectDuplicateNames(
      deployments.map(d => d.name), 'deployment name', `model '${m.name}'`,
      true);
  const seenTargets = new Map<string, {name: string; target: string}>();
  for (const d of deployments) {
    const key = deploymentTargetKey(d.target);
    const first = seenTargets.get(key);
    if (first !== undefined) {
      const resource = first.target === d.target ?
          `the same resource '${d.target}'` :
          `the same resource: '${first.target}' and '${d.target}' name one ` +
              `graph, since Spanner and BigQuery read a graph name without ` +
              `regard to case`;
      throw new SemanticModelError(
          `Semantic model load error: model '${m.name}': deployments '${
              first.name}' and '${d.name}' target ${
              resource}; each deployment must target a distinct resource`);
    }
    seenTargets.set(key, {name: d.name, target: d.target});
  }

  const description = composeDescription(m.description);

  // `version` records the flavor the document was written in, so a consumer
  // (e.g. a pull) can return the model in that same flavor.
  const model: SemanticModel =
      {name: m.name, version, entities, relationships, metrics};
  if (opts.thirdPartyImport) model.thirdPartyImport = true;
  if (actions.length) model.actions = actions;
  if (constraints.length) model.constraints = constraints;
  if (deployments.length) model.deployments = deployments;
  if (block.values.profiles?.length) model.profiles = block.values.profiles;
  if (description) model.description = description;
  const ai = aiContextOrUndefined(m.ai_context);
  if (ai) model.aiContext = ai;
  // The blocks the model keeps are carried verbatim.
  if (block.kept) model.customExtensions = block.kept;
  return model;
}

// Converts the dataset `ds`, whose GOOGLE blocks convertModel has read into
// `block`. Messages call it a `word`.
function convertDataset(
    ds: DatasetDoc, block: ReturnType<typeof readGoogleBlocks>,
    version: FormatVersion, opts: LoadOptions, warnings: string[],
    dialect: string, word: string): Entity {
  rejectInvalidName('entity', ds.name);
  const ctxLabel = `${word} '${ds.name}'`;
  // An abstract entity has no physical table, so it carries no source (empty
  // dataSource) and no key -- both are meaningless for a class never
  // materialized. Only a concrete entity's source is parsed.
  const parsedSource = ds.source !== undefined ?
      parseSource(ds.source, opts, ctxLabel, warnings, version) :
      undefined;
  const dataSource = parsedSource ? parsedSource.dataSource : '';
  const keys = ds.primary_key ?? [];
  const fields = (ds.fields ?? []).map(
      f => convertField(f, ds.name, version, dialect, ctxLabel));
  rejectDuplicateNames(fields.map(f => f.name), 'field name', ctxLabel, true);

  const entity: Entity = {name: ds.name, dataSource, keys, fields};
  if (parsedSource) entity.authoredSource = parsedSource.authoredSource;
  if (parsedSource?.sourceDialect) {
    entity.sourceDialect = parsedSource.sourceDialect;
  }
  if (ds.unique_keys && ds.unique_keys.length)
    entity.uniqueKeys = ds.unique_keys;
  const parents = ds.extends ?? block.values.extends;
  if (parents && parents.length) entity.extends = parents;
  if (ds.abstract) entity.abstract = true;
  const description = composeDescription(ds.description);
  if (description) entity.description = description;
  const ai = aiContextOrUndefined(ds.ai_context);
  if (ai) entity.aiContext = ai;
  if (block.kept) entity.customExtensions = block.kept;
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
    throw new SemanticModelError(
        `Semantic model load error: ${ctx}: datatype '${raw}' is not valid ` +
        `in a '${version}' document; expected ${accepted} ` +
        `${DATA_TYPES.join(', ')}.`);
  }
  return result.type;
}

function rejectVanillaShortFormExpression(
    expr: ExpressionDoc, ctx: string): void {
  if (typeof expr !== 'string') return;
  throw new SemanticModelError(
      `Semantic model load error: ${ctx}: a '${OSSIE_VERSION}' document ` +
      `does not support the bare-string 'expression' shorthand. Write the ` +
      `per-dialect form instead:\n` +
      `  expression:\n` +
      `    dialects:\n` +
      `      - dialect: ANSI_SQL\n` +
      `        expression: ${JSON.stringify(expr)}\n` +
      `or set the document version to '${GOOGLE_VERSION}'.`);
}

function convertExpression(
    raw: z.infer<typeof expressionSchema>, version: FormatVersion,
    dialect: string, ctx: string): {
  dialects: DialectExpression[];
  stringForm: boolean;
  picked: PickedExpression;
} {
  if (version === OSSIE_VERSION) {
    rejectVanillaShortFormExpression(raw, ctx);
  }
  if (typeof raw === 'string') {
    return {
      dialects: [{dialect: 'ANSI_SQL', expression: raw}],
      stringForm: true,
      picked: {expression: raw},
    };
  }
  return {
    dialects: raw.dialects.map(
        d => ({dialect: d.dialect as SqlDialect, expression: d.expression})),
    stringForm: false,
    picked: pickDialect(raw, dialect),
  };
}

type FieldExpression = Pick<
    Field,
    'expression'|'dialects'|'stringForm'|'importedExpression'|'importedDialect'>;

// The binding a field takes from its expression: every dialect text, and the
// texts picked for `dialect`.
function fieldExpression(
    raw: ExpressionDoc, version: FormatVersion, dialect: string,
    ctx: string): FieldExpression {
  const {dialects, stringForm, picked} =
      convertExpression(raw, version, dialect, ctx);
  const out: FieldExpression = {dialects, stringForm};
  if (picked.expression !== undefined) out.expression = picked.expression;
  if (picked.importedExpression !== undefined) {
    out.importedExpression = picked.importedExpression;
    out.importedDialect = picked.importedDialect;
  }
  return out;
}

// A field expression written outside a model document, such as in a profile
// file, checked against the loader's schema and read as a load reads a field's
// expression, with the texts picked for `dialect`. The string form means
// ANSI_SQL in either flavor. Throws naming `where` and every problem the schema
// finds, or naming `where` when the expression holds no SQL for a field of
// `entity`.
export function parseFieldExpression(
    raw: unknown, where: string, dialect: string,
    entity: string): FieldExpression {
  return readFieldExpression(
      raw, where, dialect, doc => noSqlProblem(doc, entity));
}

// A field expression read as parseFieldExpression reads it, with `problemOf`
// saying why one the schema accepts holds no SQL.
export function readFieldExpression(
    raw: unknown, where: string, dialect: string,
    problemOf: (doc: ExpressionDoc) => string | undefined): FieldExpression {
  if (typeof raw !== 'string' &&
      (raw === null || typeof raw !== 'object' || Array.isArray(raw))) {
    throw new SemanticModelError(
        `${where}: 'expression' must be a string or a list of dialects`);
  }
  const result = typeof raw === 'string' ?
      z.string().safeParse(raw) :
      expressionObjectSchema.safeParse(raw);
  if (!result.success) {
    throw new SemanticModelError(keyProblems(
        result.error, expressionObjectSchema, 'expression', raw, where));
  }
  const problem = problemOf(result.data);
  if (problem) {
    throw new SemanticModelError(`${where}: ${problem}; write the field's SQL`);
  }
  return fieldExpression(result.data, GOOGLE_VERSION, dialect, where);
}

// A profile's binding of a field, read as parseFieldExpression reads a
// profile file's expression. A binding built in memory with no dialect list
// is read as expressionDocOf gives it, and is checked for SQL as
// noSqlProblemOf checks it, since a dialect list cannot hold an imported text
// with no imported dialect, or one marked BIGQUERY beside a target text.
// Throws as parseFieldExpression does.
export function parseFieldBinding(
    binding: Pick<
        Field,
        'expression'|'dialects'|'stringForm'|'importedExpression'|
        'importedDialect'>,
    where: string, dialect: string, entity: string): FieldExpression {
  const doc = expressionDocOf(binding);
  if (binding.dialects?.length) {
    return parseFieldExpression(doc, where, dialect, entity);
  }
  return readFieldExpression(
      doc, where, dialect, () => noSqlProblemOf(binding, entity));
}

// Converts the field `f` of the entity `entityName`, which messages call
// `entityLabel`.
function convertField(
    f: FieldDoc, entityName: string, version: FormatVersion, dialect: string,
    entityLabel: string): Field {
  rejectInvalidName('field', f.name, entityLabel);
  // `label`, `dimension`, and AI-first annotations are carried structurally on
  // the IR (not folded into `description`) so an emitter can route each to its
  // own destination and a 1P round-trip stays lossless.
  const description = composeDescription(f.description);
  const ctx = `field '${entityName}.${f.name}'`;

  const field: Field = {name: f.name};
  if (f.expression !== undefined) {
    Object.assign(field, fieldExpression(f.expression, version, dialect, ctx));
  }
  // else: an unbound field. It carries meaning (label, description, AI context)
  // but names no physical column. A field is unbound exactly when it has no
  // `expression` -- there is no separate flag. The availability pass
  // (pruneUnavailable) drops each unbound field, and whatever depends on it,
  // before generation, so one logical model can serve stores that bind
  // different subsets of columns. validateDeployments rejects one on a
  // concrete leaf entity when a graph deployment uses the model file's own
  // bindings.
  const type = resolveDataType(f.datatype, version, ctx);
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
  rejectGoogleBlock(f.custom_extensions, version, 'field', ctx);
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
    r: RelationshipDoc, version: FormatVersion, entityNames: Set<string>,
    word: string): Relationship {
  rejectInvalidName('relationship', r.name);
  const ctx = `relationship '${r.name}'`;
  rejectVanillaRelationshipDescription(r, version);
  if (!entityNames.has(r.from)) {
    throw new SemanticModelError(
        `${ctx}: ${undefinedEndpointProblem('from', r.from, word)}`);
  }
  if (!entityNames.has(r.to)) {
    throw new SemanticModelError(
        `${ctx}: ${undefinedEndpointProblem('to', r.to, word)}`);
  }
  const fromColumns = r.from_columns ?? [];
  const toColumns = r.to_columns ?? [];
  if (fromColumns.length !== toColumns.length) {
    throw new SemanticModelError(
        joinLengthMessage(r.name, fromColumns.length, toColumns.length));
  }

  const relationship: Relationship = {
    name: r.name,
    source: {entity: r.from, columns: fromColumns},
    destination: {entity: r.to, columns: toColumns},
  };
  const block =
      readGoogleBlocks(r.custom_extensions, version, 'relationship', ctx);
  const description =
      composeDescription(r.description ?? block.values.description);
  if (description) relationship.description = description;
  const ai = aiContextOrUndefined(r.ai_context);
  if (ai) relationship.aiContext = ai;
  if (block.kept) relationship.customExtensions = block.kept;
  return relationship;
}

function convertMetric(
    mt: MetricDoc, version: FormatVersion, entities: Entity[],
    warnings: string[], dialect: string, word: string,
    impliedDialect: string|null|undefined, thirdPartyImport: boolean|undefined,
    document: string, outcomes?: TranspileOutcomes): Metric {
  rejectInvalidName('metric', mt.name);
  const ctx = `metric '${mt.name}'`;
  const entityNames = entities.map(e => e.name);
  const block = readGoogleBlocks(mt.custom_extensions, version, 'metric', ctx);
  // The anchor the author wrote, natively or in a vanilla GOOGLE block.
  const authored = mt.entity ?? block.values.entity;
  const {dialects, stringForm, picked} =
      convertExpression(mt.expression, version, dialect, ctx);
  // Infer referenced entities across all dialect entries of the metric.
  const {referenced, warning: mw} = inferMetricEntities(
      {
        name: mt.name,
        authoredEntity: authored,
        expression: picked.expression,
        importedExpression: picked.importedExpression,
        importedDialect: picked.importedDialect,
        dialects,
      },
      entityNames, dialect, impliedDialect, version);
  const ew = metricWarning(
      {
        name: mt.name,
        authoredEntity: authored,
        dialects,
        stringForm,
        ...picked
      },
      {entities, version, thirdPartyImport}, dialect, impliedDialect, document,
      outcomes);
  if (ew) warnings.push(ew);
  if (mw) warnings.push(mw);
  const metric: Metric = {name: mt.name, dialects, stringForm};
  if (authored !== undefined) {
    // Like a relationship endpoint, an anchor must name a dataset the model
    // declares; a dangling one would attach the metric to nothing downstream.
    if (!entityNames.includes(authored)) {
      throw new SemanticModelError(
          `Semantic model load error: ${ctx}: 'entity' names '${authored}', ` +
          `which is not ${word === 'entity' ? 'an' : 'a'} ${word} in this ` +
          `model.`);
    }
    // What the author wrote wins over inference. `authoredEntity` records that
    // it was written, so a pull can write it back rather than re-infer it.
    metric.authoredEntity = authored;
    metric.entity = authored;
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
  if (block.kept) metric.customExtensions = block.kept;
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
    throw new SemanticModelError(
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
      throw new SemanticModelError(
          `${where}: parameter ${p.name ? `'${p.name}' ` : ''}states 'field: ${
              fieldName}', which is not a valid 'Concept.field' reference; ` +
          `expected two dot-separated parts such as 'field: Order.orderId'.`);
    }
  } else if (conceptName !== undefined && fieldName?.includes('.')) {
    throw new SemanticModelError(
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
    throw new SemanticModelError(
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
    throw new SemanticModelError(
        `${where}: parameter ${p.name ? `'${p.name}' ` : ''}states a '${
            typeKey}' alongside ${projectionDesc}. A ` +
        `projected parameter takes its type from the field, so stating one ` +
        `here is a second place for it to be wrong: if the type is wrong, ` +
        `fix the field; if the call needs a different one, cast in the DML.`);
  }

  const name = p.name ?? fieldName;
  if (name === undefined) {
    throw new SemanticModelError(
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

// One line per problem that `schema` finds in the value of `key` on
// `subject`.
function keyProblems(
    error: z.ZodError, schema: z.ZodType, key: string, value: unknown,
    subject: string): string {
  const doc = {[key]: value};
  return schemaProblems(
      error.issues.map(i => ({...i, path: [key, ...i.path]})),
      {schema: z.object({[key]: schema}), doc, authored: doc, extended: true,
       subject});
}

type SchemaIssue = z.ZodError['issues'][number];

// What a schema error is read against. `doc` is the value `schema` read, and
// `authored` is `doc` as written. A line names `subject` unless it is about a
// named object inside `doc`.
interface SchemaInput {
  schema: z.ZodType;
  doc: unknown;
  authored: unknown;
  extended: boolean;
  subject: string;
  // The flavor whose word for an entry of `datasets` lines use, when it is not
  // the document's own (LoadOptions.messageFlavor).
  words?: FormatVersion;
}

// The noun a message gives an entry of each list of named objects in a model
// document. An entry of `datasets` takes its noun from entityWord instead,
// since the word depends on the flavor.
const ENTRY_NOUNS = new Map([
  ['semantic_model', 'model'], ['datasets', 'dataset'], ['fields', 'field'],
  ['relationships', 'relationship'], ['metrics', 'metric'],
  ['actions', 'action'], ['parameters', 'parameter'],
  ['constraints', 'constraint'], ['deployments', 'deployment'],
]);

// What a message says a schema expects.
const EXPECTED: Record<string, string> = {
  string: 'a string',
  boolean: 'true or false',
  array: 'a list',
  object: 'a mapping',
  record: 'a mapping',
};

// A value as a message describes it.
function described(value: unknown): string {
  if (value === undefined) return 'missing';
  if (value === null) return 'empty';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'object') return 'a mapping';
  if (typeof value !== 'string') return String(value);
  return value.includes('\n') ? 'a string' : `'${value}'`;
}

// The keys the object at `path` in `schema` takes, apart from unlisted keys.
function keysAt(schema: z.ZodType, path: readonly PropertyKey[]): string[] {
  // `s` without its optional, nullable and pipe wrappers. Of a union, the
  // member that is a `kind`.
  const unwrapped = (s: unknown, kind: Function): unknown => {
    if (s instanceof z.ZodOptional || s instanceof z.ZodNullable) {
      return unwrapped(s.unwrap(), kind);
    }
    if (s instanceof z.ZodPipe) return unwrapped(s.in, kind);
    if (s instanceof z.ZodUnion) {
      return s.options.map(o => unwrapped(o, kind))
          .find(o => o instanceof kind);
    }
    return s;
  };
  let node: unknown = schema;
  for (const seg of path) {
    const holder =
        unwrapped(node, typeof seg === 'number' ? z.ZodArray : z.ZodObject);
    node = holder instanceof z.ZodArray ? holder.element :
        holder instanceof z.ZodObject   ? holder.shape[String(seg)] :
                                          undefined;
  }
  const object = unwrapped(node, z.ZodObject);
  if (!(object instanceof z.ZodObject)) return [];
  return Object.keys(object.shape)
      .filter(k => !UNLISTED_KEYS.has(object.shape[k]));
}

// The keys a Google-flavor model file takes on the object at `path` below its
// model, such as ['datasets', 0, 'fields', 0] for a field.
export function modelFileKeysAt(path: readonly PropertyKey[]): string[] {
  return keysAt(makeDocumentSchema(true, true), ['semantic_model', 0, ...path]);
}

// Where `path` points in `input.doc`: the innermost named object, as messages
// name it, and the key below it, such as "'data' of entry 1 of
// 'custom_extensions'". `spelled` gives a key as the author wrote it: a
// Google-flavor model's `datasets` is `entities` unless the author wrote
// `datasets`.
function schemaLocation(path: readonly PropertyKey[], input: SchemaInput): {
  subject: string; name?: string; place: string; value: unknown;
  spelled: (key: PropertyKey) => string;
} {
  let subject = input.subject;
  let name: string|undefined;
  let entity: string|undefined;
  let datasets = 'datasets';
  let rest: PropertyKey[] = [];
  let node: any = input.doc;
  for (const seg of path) {
    node = node?.[seg];
    const list = rest.length === 1 ? String(rest[0]) : '';
    const noun = list === 'datasets' ?
        entityWord(input.words ?? (input.extended ? GOOGLE_VERSION : OSSIE_VERSION)) :
        ENTRY_NOUNS.get(list);
    if (typeof seg !== 'number' || !noun) {
      rest.push(seg);
      continue;
    }
    rest = [];
    name = typeof node?.name === 'string' ? node.name : undefined;
    const named =
        name === undefined ? `${noun} number ${seg + 1}` : `${noun} '${name}'`;
    if (list === 'semantic_model') {
      const written = (input.authored as any)?.semantic_model?.[seg];
      datasets = input.extended && written?.datasets === undefined ?
          'entities' :
          'datasets';
    }
    if (list === 'datasets') entity = name;
    if (list === 'fields' && name !== undefined && entity !== undefined) {
      name = `${entity}.${name}`;
      subject = `field '${name}'`;
    } else {
      subject = list === 'fields' || list === 'parameters' ?
          `${named} of ${subject}` :
          named;
    }
  }
  const spelled = (key: PropertyKey) =>
      key === 'datasets' ? datasets : String(key);
  const place =
      rest.map(s => typeof s === 'number' ? `entry ${s + 1}` :
                                            `'${spelled(s)}'`)
          .reverse()
          .join(' of ');
  return {subject, name, place, value: node, spelled};
}

// One line per problem of a schema error, naming the object and the key and
// saying how to fix it.
function schemaProblems(
    issues: readonly SchemaIssue[], input: SchemaInput): string {
  // zod also checks the length of a value of the wrong type, as for
  // `target: []`. The type is what to fix, so that check gives no line.
  const mistyped = new Set(issues.filter(i => i.code === 'invalid_type')
                               .map(i => JSON.stringify(i.path)));
  return issues
      .filter(
          i => i.code !== 'too_small' || !mistyped.has(JSON.stringify(i.path)))
      .map(i => schemaProblem(i, input))
      .join('\n');
}

function schemaProblem(issue: SchemaIssue, input: SchemaInput): string {
  if (issue.code === 'invalid_union') {
    // When only one alternative takes the value's type, report its problems.
    const typed = issue.errors.filter(
        b => !b.every(i => i.code === 'invalid_type' && !i.path.length));
    if (typed.length === 1) {
      return schemaProblems(
          typed[0].map(i => ({...i, path: [...issue.path, ...i.path]})),
          input);
    }
  }
  const {subject, name, place, value, spelled} =
      schemaLocation(issue.path, input);
  const at = place ? `${subject}: ${place}` : subject;
  const takes = (what: string|undefined) =>
      `${at} is ${described(value)}; it takes ${what}`;
  const expected = (type: string) => EXPECTED[type] ?? type;
  switch (issue.code) {
    case 'unrecognized_keys': {
      const keys = keysAt(input.schema, issue.path).map(k => `'${spelled(k)}'`);
      return `${subject}: unknown key${issue.keys.length > 1 ? 's' : ''} ${
          listed(issue.keys.map(k => `'${k}'`))}${
          place ? ` in ${place}` : ''}; it takes ${listed(keys)}`;
    }
    case 'invalid_type':
      return takes(expected(issue.expected));
    case 'invalid_union': {
      // A vanilla document writes an expression only as a mapping.
      const types = issue.errors.flatMap(b => b.flatMap(
          i => i.code === 'invalid_type' ? [i.expected] : []));
      const offered = types.filter(
          t => input.extended || t !== 'string' ||
              issue.path.at(-1) !== 'expression');
      return takes(listed([...new Set(offered.map(expected))], 'or'));
    }
    case 'invalid_value':
      return takes(listed(issue.values.map(v => `'${String(v)}'`), 'or'));
    case 'too_small':
      if (issue.origin === 'array') {
        return `${at} is an empty list; it takes at least one entry`;
      }
      if (issue.origin === 'string') {
        return `${at} is empty; it takes a non-empty string`;
      }
      break;
    case 'custom':
      // A rule on a named object quotes the object's name in its message.
      if (name !== undefined && issue.message.includes(`'${name}'`)) {
        return issue.message;
      }
      return `${subject}: ${issue.message}`;
  }
  return `${at}: ${issue.message}`;
}

// An executor written outside a model document, such as in a profile file,
// checked against the loader's schema and converted as a load converts one.
// Throws naming `where` and every problem the schema finds.
export function parseExecutor(raw: unknown, where: string): Executor {
  const result = executorSchema.safeParse(raw);
  if (!result.success) {
    throw new SemanticModelError(
        keyProblems(result.error, executorSchema, 'executor', raw, where));
  }
  return convertExecutor(result.data);
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
// Dialect names in the document must match ALLOWED_DIALECTS (uppercase)
// exactly; only `preferred` (which comes from LoadOptions.dialect) is matched
// without regard to case. No transpilation is performed here; chosen
// expressions are passed through verbatim. At least one form is set.
//
// The fallbacks differ in risk:
//   - ANSI_SQL is the AI-first format's default expression language (ANSI
//     SQL:2003 core), chosen to be valid across targets, BigQuery included.
//     Using it as `expression` is the intended authoring path, so it draws no
//     message unless it double-quotes a name that the target reads as text
//     (see expressionWarning).
//   - When neither the target nor ANSI_SQL is present, `expression` is left
//     unset and only `importedExpression` is populated. That text needs
//     translating, so expressionWarning warns about it for each field and
//     metric, naming the dialect, where a table of the target dialect runs it
//     (see fieldWarnings and metricWarning).
interface PickedExpression {
  expression?: string;
  importedExpression?: string;
  importedDialect?: string;
}

function pickDialect(
    expr: z.infer<typeof expressionObjectSchema>,
    preferred: string): PickedExpression {
  const preferredUpper = preferred.toUpperCase();
  const byName = (name: string) =>
      expr.dialects.find(d => d.dialect === name.toUpperCase());

  // The original vendor variant, if any: the first dialect that is neither the
  // target nor the portable canonical. Kept as `importedExpression`.
  const vendor = expr.dialects.find(
      d => d.dialect !== preferredUpper && d.dialect !== FALLBACK_DIALECT);

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

  if (fallsBackToAnsi(expr.dialects, preferred)) {
    out.expression = byName(FALLBACK_DIALECT)!.expression;
    return out;
  }

  // Neither target nor canonical: keep only the imported vendor form; the
  // target `expression` awaits a transpile pass. expressionWarning says so.
  return out;
}

interface ParsedSource {
  dataSource: string;
  authoredSource: string;
  // The looked-up dialect of a Cloud SQL, Spanner or third-party table, when
  // the load has it.
  sourceDialect?: string;
}

const MAX_CATALOG_NAME_LENGTH = 4000;

const BIGQUERY_TABLE_URI =
    /^\/\/bigquery\.googleapis\.com\/projects\/([^/]+)\/datasets\/([^/.]+)\/tables\/([^/.]+)$/;
// A BigLake table sits in a namespace of an Iceberg REST catalog, or in a
// database of a Hive catalog.
const BIGLAKE_TABLE_URI =
    /^\/\/biglake\.googleapis\.com\/projects\/([^/]+)\/catalogs\/([^/.]+)\/(namespaces|databases)\/([^/.]+)\/tables\/([^/.]+)$/;
const SPANNER_TABLE_URI =
    /^\/\/spanner\.googleapis\.com\/projects\/([^/]+)\/instances\/([^/]+)\/databases\/([^/]+)\/tables\/[^/]+$/;
const ALLOYDB_TABLE_URI =
    /^\/\/alloydb\.googleapis\.com\/projects\/([^/]+)\/locations\/([^/]+)\/clusters\/([^/]+)\/databases\/([^/]+)\/schemas\/[^/]+\/tables\/[^/]+$/;
const LEGACY_ALLOYDB_INSTANCE_URI =
    /^\/\/alloydb\.googleapis\.com\/projects\/([^/]+)\/locations\/([^/]+)\/clusters\/([^/]+)\/instances\/[^/]+\/databases\/([^/]+)\/tables\/([^/]+)$/;
// A Cloud SQL table. A MySQL table sits in a database; a PostgreSQL or SQL
// Server table sits in a schema in a database. The shape tells MySQL from the
// other two but not PostgreSQL from SQL Server, so the dialect comes from the
// table's catalog entry, not from the source (see sourcesDialect).
const CLOUDSQL_TABLE_URI =
    /^\/\/cloudsql\.googleapis\.com\/projects\/([^/]+)\/locations\/([^/]+)\/instances\/([^/]+)\/databases\/[^/]+\/tables\/[^/]+$/;
const CLOUDSQL_SCHEMA_TABLE_URI =
    /^\/\/cloudsql\.googleapis\.com\/projects\/([^/]+)\/locations\/([^/]+)\/instances\/([^/]+)\/databases\/([^/]+)\/schemas\/[^/]+\/tables\/[^/]+$/;

// A double quote or a backtick, which no resource name or entry name holds.
const QUOTE = /["`]/;

// A Cloud SQL table written as its resource name or resource URI: its
// project, location and instance, and its resource name with no leading `//`,
// which is also the id of its catalog entry in the `@cloudsql` entry group.
export interface CloudSqlTable {
  project: string;
  location: string;
  instance: string;
  resourceName: string;
  // False for a MySQL table, whose name has no schema.
  inSchema: boolean;
}

// The Cloud SQL table `source` names, or undefined when it names none. A name
// with quotes names none, so push reports it without looking it up.
export function cloudSqlTableOf(source: string): CloudSqlTable|undefined {
  const uri = asResourceUri(source.trim());
  if (QUOTE.test(uri)) return undefined;
  const mysql = uri.match(CLOUDSQL_TABLE_URI);
  const m = mysql ?? uri.match(CLOUDSQL_SCHEMA_TABLE_URI);
  if (!m) return undefined;
  return {
    project: m[1], location: m[2], instance: m[3], resourceName: uri.slice(2),
    inSchema: !mysql,
  };
}

// A BigQuery, BigLake, Spanner or AlloyDB table written as its resource name
// or resource URI: its system, which names its catalog entry group, the parts
// that say where its catalog entry lives, and its resource name with no
// leading `//`, which is its entry id. A Cloud SQL table is cloudSqlTableOf's.
export type SourceTable = {resourceName: string; project: string}&(
    {system: 'bigquery'; dataset: string; table: string}|
    {system: 'biglake'; catalog: string; hive: boolean}|
    {system: 'spanner'; instance: string}|
    {system: 'alloydb'; location: string});

// The table `source` names, or undefined when it names none of these.
export function sourceTableOf(source: string): SourceTable|undefined {
  const uri = asResourceUri(source.trim());
  const resourceName = uri.slice(2);
  let m = uri.match(BIGQUERY_TABLE_URI);
  if (m) {
    return {
      system: 'bigquery', resourceName, project: m[1], dataset: m[2],
      table: m[3],
    };
  }
  m = uri.match(BIGLAKE_TABLE_URI);
  if (m) {
    const hive = m[3] === 'databases';
    return {system: 'biglake', resourceName, project: m[1], catalog: m[2], hive};
  }
  m = uri.match(SPANNER_TABLE_URI);
  if (m) return {system: 'spanner', resourceName, project: m[1], instance: m[2]};
  m = uri.match(ALLOYDB_TABLE_URI);
  if (m) return {system: 'alloydb', resourceName, project: m[1], location: m[2]};
  return undefined;
}

// A GCP resource name: a Google Cloud service host and a path, with no leading
// `//`, such as `bigquery.googleapis.com/projects/p/datasets/d/tables/t`.
const RESOURCE_NAME = /^[a-z][a-z0-9-]*\.googleapis\.com\//;

// `value` as a resource URI: a GCP resource name gets the leading `//`, and
// anything else is returned as it is. The IR and the checks read a source or a
// target as its URI; the resource name the author wrote stays in
// `authoredSource` for a source and in `uri` for a target.
export function asResourceUri(value: string): string {
  return RESOURCE_NAME.test(value) ? `//${value}` : value;
}

// `value` as a GCP resource name: a resource URI loses its leading `//`, and
// anything else is returned as it is. The inverse of `asResourceUri`, for
// messages and output, which show the form an author writes.
export function asResourceName(value: string): string {
  const name = value.replace(/^\/\//, '');
  return RESOURCE_NAME.test(name) ? name : value;
}

// What to do about a value written as a resource URI: write its GCP resource
// name. The source and target messages share it, so they say it alike.
export function resourceUriFix(uri: string): string {
  return `a resource URI; write its GCP resource name, without the leading ` +
      `'//': '${asResourceName(uri)}'`;
}

// The Knowledge Catalog name prefix of each first-party table, the number of
// segments after it, and the GCP resource name those segments give. A
// Spanner name's instance config has no place in the resource name.
const CATALOG_NAME_FORMS: Array<[string, number, (s: string[]) => string]> = [
  ['bigquery:', 3,
   s => `bigquery.googleapis.com/projects/${s[0]}/datasets/${s[1]}/tables/${
       s[2]}`],
  ['biglake:table:', 4,
   s => `biglake.googleapis.com/projects/${s[0]}/catalogs/${
       s[1]}/namespaces/${s[2]}/tables/${s[3]}`],
  ['spanner:', 5,
   s => `spanner.googleapis.com/projects/${s[0]}/instances/${
       s[2]}/databases/${s[3]}/tables/${s[4]}`],
  ['alloydb:', 6,
   s => `alloydb.googleapis.com/projects/${s[0]}/locations/${
       s[1]}/clusters/${s[2]}/databases/${s[3]}/schemas/${s[4]}/tables/${
       s[5]}`],
  ['cloudsql_mysql:', 5,
   s => `cloudsql.googleapis.com/projects/${s[0]}/locations/${
       s[1]}/instances/${s[2]}/databases/${s[3]}/tables/${s[4]}`],
  ['cloudsql_postgresql:', 6, cloudSqlSchemaTable],
  ['cloudsql_sqlserver:', 6, cloudSqlSchemaTable],
];

function cloudSqlSchemaTable(s: string[]): string {
  return `cloudsql.googleapis.com/projects/${s[0]}/locations/${
      s[1]}/instances/${s[2]}/databases/${s[3]}/schemas/${s[4]}/tables/${s[5]}`;
}

// What a source written as a resource URI, as a Knowledge Catalog name of a
// table kcmd reads, or with quotes in a resource name or in an entry name
// outside a system entry group is, and the name to write instead when there
// is one; undefined for any other source. The loader rejects such a source,
// and pull warns for one an older push stored.
export function oldSourceForm(source: string): string|undefined {
  const unquoted = unquotedName(source);
  if (unquoted !== undefined) {
    const quotes = 'a name with quotes in it; resource names and entry ' +
        'names take no quotes';
    return !unquoted                       ? quotes :
        hasUnquotedWhitespace(unquoted) ? `${quotes}, and ${NO_SPACE}` :
                                          `${quotes}, so write '${unquoted}'`;
  }
  const name = asResourceName(source);
  if (name !== source && isAcceptedSource(name)) return resourceUriFix(source);
  const built = catalogNameResourceName(source);
  const plain = built === undefined ? undefined : unquotedName(built) ?? built;
  const write = "a Knowledge Catalog name; write the table's GCP resource name";
  if (plain && isAcceptedSource(plain)) return `${write}: '${plain}'`;
  if (!/^[a-z_]+:/.test(source) ||
      !(isAcceptedSource(source) || isAcceptedSource(built ?? ''))) {
    return undefined;
  }
  return plain && hasUnquotedWhitespace(plain) ?
      `a Knowledge Catalog name, and ${NO_SPACE}` :
      write;
}

// Why no name to write is given when that name would hold whitespace that
// hasUnquotedWhitespace counts.
export const NO_SPACE =
    "a source can hold a space in the table's own name, but not at its end";

// Why a source or a deployment target with whitespace at either end is refused.
export const AROUND_WHITESPACE = 'begins or ends with whitespace; remove it';

// The resource name of a table in each Google Cloud service a source can
// name, with a placeholder for each name in it. A Cloud SQL table has one
// form without a schema and one with, and a BigLake table one for each kind
// of catalog.
export const TABLE_FORMS = {
  bigquery:
      'bigquery.googleapis.com/projects/<project>/datasets/<dataset>/tables/<table>',
  spanner:
      'spanner.googleapis.com/projects/<project>/instances/<instance>/databases/<database>/tables/<table>',
  alloydb:
      'alloydb.googleapis.com/projects/<project>/locations/<location>/clusters/<cluster>/databases/<database>/schemas/<schema>/tables/<table>',
  cloudsql:
      'cloudsql.googleapis.com/projects/<project>/locations/<location>/instances/<instance>/databases/<database>/tables/<table>',
  cloudsqlSchema:
      'cloudsql.googleapis.com/projects/<project>/locations/<location>/instances/<instance>/databases/<database>/schemas/<schema>/tables/<table>',
  biglake:
      'biglake.googleapis.com/projects/<project>/catalogs/<catalog>/namespaces/<namespace>/tables/<table>',
  biglakeHive:
      'biglake.googleapis.com/projects/<project>/catalogs/<catalog>/databases/<database>/tables/<table>',
};

// What each form in TABLE_FORMS is for, where its service has two.
const FORM_USES: Record<string, string> = {
  cloudsql: 'MySQL',
  cloudsqlSchema: 'PostgreSQL, SQL Server',
  biglake: 'Iceberg REST catalog',
  biglakeHive: 'Hive catalog',
};

// `form` with its last placeholders replaced by `parts`, in order, or
// undefined when `form` has fewer placeholders than `parts`.
export function fillForm(form: string, parts: string[]): string|undefined {
  const skip = (form.match(/<\w+>/g) ?? []).length - parts.length;
  if (skip < 0) return undefined;
  let n = 0;
  return form.replace(
      /<\w+>/g, name => n++ < skip ? name : parts[n - 1 - skip]);
}

// The name of each service a table form starts with, as messages say it.
const SERVICE_NAMES: Record<string, string> = {
  bigquery: 'BigQuery',
  biglake: 'BigLake',
  spanner: 'Spanner',
  alloydb: 'AlloyDB',
  cloudsql: 'Cloud SQL',
};

// Why `parts`, a bare name's parts read into the last placeholders of `form`,
// name no table there only because a part holds a dot. Such a part was
// quoted, so it is one name, and `form` takes no dot in its place. Undefined
// for any other name. When `service` is false, the reason names neither the
// part's role nor the service.
export function dottedPartProblem(
    parts: string[], form: string, service = true): string|undefined {
  const takes = (names: string[]) => {
    const name = fillForm(form, names);
    return name !== undefined && oldSourceForm(name) === undefined &&
        isAcceptedSource(name);
  };
  const plain = parts.map(p => p.replaceAll('.', '_'));
  if (takes(parts) || !takes(plain)) return undefined;
  const i = parts.findIndex(
      (p, j) => p !== plain[j] && !takes(plain.map((q, k) => k === j ? p : q)));
  if (i < 0) return undefined;
  if (!service) return `the quoted name '${parts[i]}' is one name, dot included`;
  const placeholders = form.match(/<\w+>/g)!;
  const role =
      placeholders[placeholders.length - parts.length + i].slice(1, -1);
  return `the quoted name '${parts[i]}' is one ${role} name, and a ${
      SERVICE_NAMES[form.split('.')[0]]} ${role} name cannot hold a dot`;
}

// `source` with its quotes removed, written as a resource name, when it is a
// table's resource name, resource URI or entry name outside a system entry
// group, holding them; '' when removing them leaves no such name; undefined
// for any other source.
function unquotedName(source: string): string|undefined {
  if (!QUOTE.test(source)) return undefined;
  const name = source.replace(/["`]/g, '');
  const named = (s: string) =>
      !s.match(ENTRY_NAME)?.[1].startsWith('@') &&
      (ENTRY_NAME.test(s) ||
       [
         BIGQUERY_TABLE_URI, BIGLAKE_TABLE_URI, SPANNER_TABLE_URI,
         ALLOYDB_TABLE_URI, CLOUDSQL_TABLE_URI, CLOUDSQL_SCHEMA_TABLE_URI,
       ].some(re => re.test(asResourceUri(s))));
  return named(name) ? asResourceName(name) : named(source) ? '' : undefined;
}

// The GCP resource name a Knowledge Catalog name of a first-party table
// builds, accepted or not, or undefined when `fqn` is in no such shape.
function catalogNameResourceName(fqn: string): string|undefined {
  const form = CATALOG_NAME_FORMS.find(([prefix]) => fqn.startsWith(prefix));
  if (!form || fqn.length > MAX_CATALOG_NAME_LENGTH) return undefined;
  const [prefix, count, resourceName] = form;
  const segs = catalogNameSegments(fqn.slice(prefix.length));
  if (segs.length !== count || segs.some(seg => seg === '')) return undefined;
  return resourceName(segs);
}

// A catalog name's dot-separated segments. A segment containing a reserved
// character, such as a domain-scoped project, is wrapped in backticks, so the
// dots and colons inside backticks do not split or fail. Returns [] when the
// quoting is malformed (an unquoted colon, an unclosed backtick, text after a
// closing backtick, or a backtick mid-segment outside quotes). With `colons`
// set, an unquoted colon after the first backtick stays in its segment.
// Dataplex reads a fullyQualifiedName that way: it splits the system and
// subtype off at the colons before the first backtick, and keeps the rest as
// the path.
export function catalogNameSegments(path: string, colons = false): string[] {
  const out: string[] = [];
  let cur = '';
  let state: 'start'|'unquoted'|'quoted'|'after_quote' = 'start';
  let colonOk = false;
  for (let i = 0; i < path.length; i++) {
    const ch = path[i];
    if (state === 'start') {
      if (ch === '`') {
        state = 'quoted';
        colonOk = colons;
      } else if (ch === '.') {
        out.push('');
      } else if (ch === ':' && !colonOk) {
        return [];
      } else {
        cur = ch;
        state = 'unquoted';
      }
    } else if (state === 'unquoted') {
      if (ch === '.') {
        out.push(cur);
        cur = '';
        state = 'start';
      } else if (ch === '`' || (ch === ':' && !colonOk)) {
        return [];
      } else {
        cur += ch;
      }
    } else if (state === 'quoted') {
      if (ch === '`') {
        // A doubled backtick inside a quoted segment is a literal backtick.
        if (path[i + 1] === '`') {
          cur += '`';
          i++;
        } else {
          state = 'after_quote';
        }
      } else {
        cur += ch;
      }
    } else {
      if (ch === '.') {
        out.push(cur);
        cur = '';
        state = 'start';
      } else {
        return [];
      }
    }
  }
  if (state === 'quoted') return [];
  out.push(cur);
  return out;
}

// The pairs of backticks or double quotes in `text`, as the index of each
// pair's opening and closing quote, in order. A quote opens a pair only when
// the same character follows later, and the next such character closes it.
// Inside a pair, the other quote character is ordinary.
function quotePairs(text: string): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < text.length; i++) {
    const close =
        text[i] === '`' || text[i] === '"' ? text.indexOf(text[i], i + 1) : -1;
    if (close >= 0) {
      pairs.push([i, close]);
      i = close;
    }
  }
  return pairs;
}

// True when `source` holds whitespace outside a pair of backticks or double
// quotes, which marks it as a query. A space in the table's own name does not
// count (see withoutTableNameSpaces).
export function hasUnquotedWhitespace(source: string): boolean {
  const text = withoutTableNameSpaces(source);
  let from = 0;
  for (const [open, close] of quotePairs(text)) {
    if (/\s/.test(text.slice(from, open))) return true;
    from = close + 1;
  }
  return /\s/.test(text.slice(from));
}

// `source` with the spaces removed from the table's own name, the last segment
// of a resource name, resource URI, system entry name or catalog name. A name
// that ends with whitespace is left as it is.
function withoutTableNameSpaces(source: string): string {
  const named = RESOURCE_NAME.test(source.replace(/^\/\//, '')) ||
      !!source.match(ENTRY_NAME)?.[1].startsWith('@');
  const catalog =
      CATALOG_NAME_FORMS.some(([prefix]) => source.startsWith(prefix));
  const last = named ? source.lastIndexOf('/') :
      catalog        ? source.lastIndexOf('.') :
                       -1;
  const name = source.slice(last + 1);
  return last < 0 || /\s$/.test(name) ?
      source :
      source.slice(0, last + 1) + name.replaceAll(' ', '');
}

// The database a source lives in, for the one-database rule and source
// validation, or undefined when the source is in no accepted form: a bare name,
// a query, a graph rather than a table, a catalog name under a prefix kcmd does
// not accept, or one with the wrong number of segments. The result starts with
// its system, which DIALECT_OF_SYSTEM maps to the dialect the source infers,
// except for a source whose dialect is looked up (see dialectOfSources).
//
// A database is what a single query can reach: all of BigQuery, BigLake
// included because BigQuery reads it; one Spanner, AlloyDB or Cloud SQL for
// PostgreSQL database, or one Cloud SQL for MySQL or SQL Server instance. The
// segment counts are those of the Knowledge Catalog FQN reference. The shape
// of a Cloud SQL resource name cannot tell a SQL Server table from a
// PostgreSQL one, so this keys it on its database, and the one-database rule
// widens it to its instance once the lookup names SQL Server. Every
// third-party table gets the key `thirdparty`, which is no target's database.
// The one-database rule puts it in the database its entry's
// fullyQualifiedName names, or else with the other tables of its system.
export function databaseOf(written: string): string|undefined {
  if (hasUnquotedWhitespace(written)) return undefined;
  const source = asResourceUri(written);
  if (BIGQUERY_TABLE_URI.test(source) || BIGLAKE_TABLE_URI.test(source)) {
    return 'bigquery';
  }
  let m = source.match(SPANNER_TABLE_URI);
  if (m) return `spanner/${m[1]}/${m[2]}/${m[3]}`;
  // An AlloyDB database belongs to its cluster, and a table to a schema in it.
  m = source.match(ALLOYDB_TABLE_URI);
  if (m) return `alloydb/${m[1]}/${m[2]}/${m[3]}/${m[4]}`;
  // A Cloud SQL for MySQL table's database is its instance, as for the
  // `cloudsql_mysql:` form, so both spellings of one instance agree. A table
  // in a schema is in Cloud SQL for PostgreSQL or SQL Server, which the shape
  // cannot tell apart, so its key names neither engine.
  m = source.match(CLOUDSQL_TABLE_URI);
  if (m) return `cloudsql_mysql/${m[1]}.${m[2]}.${m[3]}`;
  m = source.match(CLOUDSQL_SCHEMA_TABLE_URI);
  if (m) return `cloudsql/${m[1]}.${m[2]}.${m[3]}.${m[4]}`;
  if (thirdPartyEntryOf(source)) return 'thirdparty';
  if (source.length > MAX_CATALOG_NAME_LENGTH) return undefined;
  m = source.match(/^([a-z_]+):(.+)$/);
  if (!m) return undefined;
  const seg = catalogNameSegments(m[2]);
  if (seg.length === 0 || seg.some(s => s.length === 0)) return undefined;
  const first = (n: number) => seg.slice(0, n).join('.');
  switch (m[1]) {
    case 'bigquery':
      return seg.length === 3 && !seg[1].includes('.') && !seg[2].includes('.') ?
          'bigquery' :
          undefined;
    case 'spanner':
      return seg.length === 5 ? `spanner/${seg[0]}/${seg[2]}/${seg[3]}` :
                                undefined;
    case 'alloydb':
      return seg.length === 6 ?
          `alloydb/${seg[0]}/${seg[1]}/${seg[2]}/${seg[3]}` :
          undefined;
    case 'cloudsql_mysql':
      return seg.length === 5 ? `cloudsql_mysql/${first(3)}` : undefined;
    case 'cloudsql_postgresql':
      return seg.length === 6 ? `cloudsql_postgresql/${first(4)}` : undefined;
    default:
      return undefined;
  }
}

// True when `source` names a table in a form `databaseOf` reads, as opposed to
// a legacy bare table name. An author writes only its GCP resource name
// (`parseSource` rejects the other forms); the resource URI and catalog name
// forms are read from an older push. The loader, the Knowledge Catalog emitter
// and the serializer share it so they agree on which sources are written back
// as authored.
export function isAcceptedSource(source: string|undefined): boolean {
  return source !== undefined && databaseOf(source) !== undefined;
}

// The source an entity is written with: its `authoredSource` when that names a
// table in a form `databaseOf` reads, and otherwise its `dataSource`, shown as
// a resource name. A model is serialized, shown and judged by it.
export function writtenSource(
    entity: {authoredSource?: string; dataSource?: string}): string {
  const authored = entity.authoredSource?.trim();
  return authored !== undefined && isAcceptedSource(authored) ?
      authored :
      asResourceName(entity.dataSource ?? '');
}

// Maps an accepted source string (or catalog resource path) to the IR's
// canonical `dataSource`. A GCP resource name is read as its resource URI
// first. A BigQuery or BigLake resource URI becomes the dot-separated table
// string. A Spanner, AlloyDB or Cloud SQL resource URI is returned as the URI,
// with the leading `//`. Anything else is returned trimmed. Shared by the
// loader (`parseSource`) and the Knowledge Catalog reader (`readEntityV2`), so
// a pulled entity gets the `dataSource` loading its source would give.
export function sourceToDataSource(source: string): string {
  const value = asResourceUri(source.trim());
  const bqUri = value.match(BIGQUERY_TABLE_URI);
  if (bqUri) return `${bqUri[1]}.${bqUri[2]}.${bqUri[3]}`;
  const biglakeUri = value.match(BIGLAKE_TABLE_URI);
  if (biglakeUri) {
    const [, project, catalog, , parent, table] = biglakeUri;
    return `${project}.${catalog}.${parent}.${table}`;
  }
  return value;
}

// The dialect each Cloud SQL table or view entry type gives.
export const DIALECT_OF_ENTRY_TYPE: Record<string, string> = {
  'cloudsql-mysql-table': 'MYSQL',
  'cloudsql-mysql-view': 'MYSQL',
  'cloudsql-postgresql-table': 'POSTGRES',
  'cloudsql-postgresql-view': 'POSTGRES',
  'cloudsql-sqlserver-table': 'SQLSERVER',
  'cloudsql-sqlserver-view': 'SQLSERVER',
};

// The dialect each fullyQualifiedName prefix of a third-party table gives.
export const DIALECT_OF_FQN_PREFIX = new Map([
  ['snowflake', 'SNOWFLAKE'], ['databricks', 'DATABRICKS'], ['mysql', 'MYSQL'],
  ['postgresql', 'POSTGRES'], ['sqlserver', 'SQLSERVER'],
]);
// The shape of a Knowledge Catalog entry name.
const ENTRY_NAME =
    /^projects\/[^/]+\/locations\/[^/]+\/entryGroups\/([^/]+)\/entries\/(.+)$/;
// The entry name form, as messages show it.
export const ENTRY_NAME_FORM =
    'projects/<p>/locations/<l>/entryGroups/<g>/entries/<id>';
// How a source names a table outside Google Cloud, as messages say it.
export const THIRD_PARTY_SOURCE = 'A table outside Google Cloud is written ' +
    `as the entry name of its Knowledge Catalog entry, '${ENTRY_NAME_FORM}'.`;

// The Knowledge Catalog entry of a table outside Google Cloud. Its entry group
// is not a system one. `name` is the entry name the source writes.
export interface ThirdPartyEntry {
  project: string;
  location: string;
  name: string;
}

// The third-party entry `source` names, or undefined when it names none, as
// an entry name with quotes does.
export function thirdPartyEntryOf(source: string): ThirdPartyEntry|undefined {
  const name = source.trim();
  const m = name.match(ENTRY_NAME);
  if (!m || m[1].startsWith('@') || QUOTE.test(name)) return undefined;
  const [, project, , location] = name.split('/');
  return {project, location, name};
}

// True when `entity` is written with a third-party table's entry name.
export function bindsThirdPartyTable(
    entity: {authoredSource?: string}): boolean {
  return thirdPartyEntryOf(entity.authoredSource ?? '') !== undefined;
}

// The key LoadOptions.sourceDialects holds a source's dialect under: a Cloud
// SQL table's resource name, a third-party table's entry name, or a Spanner
// table's database. Undefined for a source whose own name gives its dialect.
export function dialectLookupKey(source: string): string|undefined {
  return cloudSqlTableOf(source)?.resourceName ??
      thirdPartyEntryOf(source)?.name ?? spannerDatabaseOf(source);
}

// The resource name of the database the Spanner table `source` is in.
// Undefined for any other source and for a name with quotes.
export function spannerDatabaseOf(source: string): string|undefined {
  const uri = asResourceUri(source.trim());
  return !QUOTE.test(uri) && SPANNER_TABLE_URI.test(uri) ?
      uri.slice(2, uri.lastIndexOf('/tables/')) :
      undefined;
}

// Why `source` is not accepted when it is a Knowledge Catalog entry name in a
// system entry group, one whose id starts with `@`, such as `@bigquery`.
// Undefined for any other source. The entry id of a Google Cloud table in a
// system entry group is its GCP resource name, so the message names it as the
// source to write, without quotes, when the loader accepts that name. Any
// other id, such as a dataset's, gets an example. An id with whitespace
// outside the table's own name gets no name to write.
function systemEntrySourceError(source: string, ctx: string): string|undefined {
  const entry = source.match(ENTRY_NAME);
  if (!entry?.[1].startsWith('@')) return undefined;
  const id = entry[2].replace(/^\/\//, '').replace(/["`]/g, '');
  const where = `Semantic model load error: ${ctx}: source '${source}' is a ` +
      `Knowledge Catalog entry name in the system entry group '${entry[1]}'`;
  if (hasUnquotedWhitespace(id)) return `${where}, and ${NO_SPACE}.`;
  const write = RESOURCE_NAME.test(id) && isAcceptedSource(id) ?
      `: '${id}'` :
      `, such as ` +
          `'bigquery.googleapis.com/projects/<p>/datasets/<d>/tables/<t>'`;
  return `${where}; write the table's resource name instead${write}.`;
}

// Google Cloud services whose tables the preview does not support yet, each
// with its resource URI host and its catalog name prefix.
const UNSUPPORTED_SERVICES:
    Array<{name: string; host: string; prefix: string}> = [
  {name: 'Bigtable', host: 'bigtable.googleapis.com', prefix: 'bigtable:'},
  {
    name: 'Dataproc Metastore',
    host: 'metastore.googleapis.com',
    prefix: 'dataproc_metastore:',
  },
];

// Why `source` is not accepted when it names a table of a Google Cloud service
// the preview does not support yet, as a resource URI, a resource name, a
// catalog name or an entry name whose id is one of those. Undefined for any
// other source.
function unsupportedServiceSourceError(
    source: string, ctx: string): string|undefined {
  const uri = asResourceUri(source.match(ENTRY_NAME)?.[2] ?? source);
  const service = UNSUPPORTED_SERVICES.find(
      s => uri.startsWith(`//${s.host}/`) || source.startsWith(s.prefix));
  return service ?
      `Semantic model load error: ${ctx}: source '${source}' is a ` +
          `${service.name} resource; the preview does not support ` +
          `${service.name} sources yet.` :
      undefined;
}

// True when `source` is in a Google Cloud form, accepted or not: a resource
// name or resource URI, a catalog name of a Google Cloud system, or an entry
// name in a system entry group.
export function isGoogleCloudForm(source: string): boolean {
  const system = source.match(/^([a-z_]+):/)?.[1];
  return RESOURCE_NAME.test(source.replace(/^\/\//, '')) ||
      [...CATALOG_NAME_FORMS.map(([p]) => p),
       ...UNSUPPORTED_SERVICES.map(s => s.prefix)]
          .some(p => p.startsWith(`${system}:`)) ||
      !!source.match(ENTRY_NAME)?.[1].startsWith('@');
}

// Why `source` is not accepted when it is a catalog name under a third-party
// prefix, such as `snowflake:acme.retail.public.orders`. Undefined for any
// other source.
function thirdPartyNameError(source: string, ctx: string): string|undefined {
  return DIALECT_OF_FQN_PREFIX.has(source.match(/^([a-z]+):/)?.[1] ?? '') ?
      `Semantic model load error: ${ctx}: source '${source}' is a ` +
          `Knowledge Catalog name; write the entry name of the table's ` +
          `Knowledge Catalog entry instead, such as '${ENTRY_NAME_FORM}'.` :
      undefined;
}

// Reads an entity's `source` into the dotted name the generators use and the
// source as written. Throws on a form the loader does not accept. A profile
// file's sources are read here too, so they follow the same rules. With
// `importVersion`, the version of the model file the source is in, a bare
// table name's error also names `kcmd import`, which completes a model file's
// bare names but not a profile file's.
export function parseSource(
    source: string, opts: LoadOptions, ctx: string, warnings?: string[],
    importVersion?: FormatVersion): ParsedSource {
  const trimmed = source.trim();

  if (hasUnquotedWhitespace(trimmed)) {
    throw new SemanticModelError(
        `Semantic model load error: ${ctx}: source '${trimmed}' looks like a ` +
        `SQL query; a query-valued source is not supported yet. Bind 'source' ` +
        `to a physical table using its GCP resource name (e.g. ` +
        `'bigquery.googleapis.com/projects/<p>/datasets/<d>/tables/<t>').`);
  }
  if (trimmed !== source) {
    throw new SemanticModelError(`Semantic model load error: ${ctx}: source '${
        source}' ${AROUND_WHITESPACE}.`);
  }

  const problem = oldSourceForm(trimmed);
  // The accepted forms: a GCP resource name, or a third-party entry name.
  if (problem === undefined && isAcceptedSource(trimmed)) {
    const key = dialectLookupKey(trimmed);
    const sourceDialect = key && opts.sourceDialects?.get(key);
    return {
      authoredSource: trimmed,
      dataSource: sourceToDataSource(trimmed),
      ...(sourceDialect ? {sourceDialect} : {}),
    };
  }
  if (opts.warnUnacceptedSource) {
    warnings?.push(
        `${ctx}: source '${trimmed}' is not a valid GCP resource name.`);
    return {authoredSource: trimmed, dataSource: ''};
  }
  if (problem !== undefined) {
    throw new SemanticModelError(`Semantic model load error: ${ctx}: source '${
        trimmed}' is ${problem}.`);
  }
  // Legacy instance-based AlloyDB name: reported in any spelling with the
  // cluster-based name to write.
  const legacyAlloy =
      asResourceUri(trimmed).match(LEGACY_ALLOYDB_INSTANCE_URI);
  if (legacyAlloy) {
    throw new SemanticModelError(
        `Semantic model load error: ${ctx}: source '${trimmed}' uses the ` +
        `legacy instance-based AlloyDB URI. An AlloyDB database belongs to ` +
        `its cluster and a table to a schema in it; write ` +
        `'alloydb.googleapis.com/projects/${legacyAlloy[1]}/locations/${
            legacyAlloy[2]}/clusters/${legacyAlloy[3]}/databases/${
            legacyAlloy[4]}/schemas/<schema>/tables/${legacyAlloy[5]}'.`);
  }

  const unsupported = unsupportedServiceSourceError(trimmed, ctx) ??
      systemEntrySourceError(trimmed, ctx) ??
      thirdPartyNameError(trimmed, ctx);
  if (unsupported) throw new SemanticModelError(unsupported);

  if (trimmed.length > MAX_CATALOG_NAME_LENGTH) {
    throw new SemanticModelError(
        `Semantic model load error: ${ctx}: source exceeds the ${
            MAX_CATALOG_NAME_LENGTH}-character limit (${
            trimmed.length} characters).`);
  }

  // Bare table name: no `/`, which every resource URI and resource name has,
  // and no `:` scheme or prefix.
  const isBareTableName = trimmed.length > 0 && !trimmed.includes('/') &&
      !trimmed.includes(':');
  let dotted: string|undefined;
  if (isBareTableName) {
    // With `importVersion`, the example also names the command that completes
    // a model file's bare names.
    const viaImport = importVersion ?
        `\nOr run '${
            importCommand(
                '--source-prefix <prefix>', {version: importVersion})}' to ` +
            `complete each bare table name from the database or Knowledge ` +
            `Catalog entry group that <prefix> names.` :
        '';
    // A name whose example would hold whitespace kcmd cannot write gets no
    // name to write. Any other name gets an example built from its parts when
    // the loader accepts the example, and the general error below otherwise,
    // which says so when only a quoted name's dot keeps the example out. A
    // path in one pair of backticks counts as its parts, as import reads it
    // under a BigQuery or BigLake prefix.
    const segs = bareNameSegments(trimmed, true);
    if (segs.length > 0 && segs.length <= 4 && segs.every(s => s.length > 0)) {
      const form =
          segs.length === 4 ? TABLE_FORMS.biglake : TABLE_FORMS.bigquery;
      const write = segs.length === 4 ?
          'Write its BigLake resource name instead:' :
          "Write the table's GCP resource name instead, for example:";
      const example = fillForm(form, segs)!;
      if (hasUnquotedWhitespace(example)) {
        throw new SemanticModelError(
            `Semantic model load error: ${ctx}: bare table name '${trimmed}' ` +
            `is not a valid source, and ${NO_SPACE}. ${THIRD_PARTY_SOURCE}`);
      }
      if (oldSourceForm(example) === undefined && isAcceptedSource(example)) {
        throw new SemanticModelError(
            `Semantic model load error: ${ctx}: bare table name '${trimmed}' ` +
            `is not a valid source. ${write}\n  source: ${example}${viaImport}`);
      }
      dotted = dottedPartProblem(segs, form, false);
    }
  }

  // Each table form with its placeholders shortened, such as <p> for
  // <project>, and what it is for where its service has two.
  const forms = Object.entries(TABLE_FORMS).map(([kind, form]) => {
    const short = form.replace(
        /<(\w+)>/g,
        (_, name: string) => `<${name === 'database' ? 'db' : name[0]}>`);
    const use = FORM_USES[kind];
    return `'${short}'${use ? ` (${use})` : ''}`;
  });
  throw new SemanticModelError(
      `Semantic model load error: ${ctx}: source '${trimmed}' is not a valid ` +
      `table reference${dotted ? `; ${dotted}` : ''}. Expected a GCP ` +
      `resource name (${forms.slice(0, -1).join(', ')}, or ${forms.at(-1)}), ` +
      `or, for a table outside Google Cloud, the entry name of its ` +
      `Knowledge Catalog entry ('${ENTRY_NAME_FORM}').`);
}

// The parts of a bare table name, without their quotes. A part in backticks
// or double quotes is one name, dots included, and a doubled quote character
// in it, as in "a""b", is one literal quote. The quotes are those
// hasUnquotedWhitespace reads. Returns [] when a quote does not wrap a whole
// part. With `bigQuery`, a path in one pair of backticks, as BigQuery writes
// `p.d.t`, has the parts of the same path written without them. A path in one
// pair of double quotes is one name.
export function bareNameSegments(name: string, bigQuery: boolean): string[] {
  return bareNameParts(name, bigQuery).map(p => p.text);
}

// The parts bareNameSegments gives, each with whether quotes wrap it.
export function bareNameParts(name: string, bigQuery: boolean):
    Array<{text: string; quoted: boolean}> {
  const pairs = quotePairs(name);
  if (bigQuery && name[0] === '`' && pairs.length === 1 && pairs[0][0] === 0 &&
      pairs[0][1] === name.length - 1) {
    return bareNameParts(name.slice(1, -1), false);
  }
  const closeOf = new Map(pairs);
  const parts: Array<{text: string; quoted: boolean}> = [];
  let start = 0;
  while (true) {
    let part = /^[^.`"]*/.exec(name.slice(start))![0];
    let end = start + part.length;
    const firstClose = part ? undefined : closeOf.get(start);
    if (firstClose !== undefined) {
      let close = firstClose;
      part = name.slice(start + 1, close);
      // Pairs that touch, as in "a""b", are one name.
      while (name[close + 1] === name[start] && closeOf.has(close + 1)) {
        const next: number = closeOf.get(close + 1)!;
        part += name.slice(close + 1, next);
        close = next;
      }
      end = close + 1;
    }
    parts.push({text: part, quoted: firstClose !== undefined});
    if (end === name.length) return parts;
    if (name[end] !== '.') return [];
    start = end + 1;
  }
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
 *
 * Each document needs the SQL parser as loadModels does, so call
 * `loadSqlEngine()` first. Without it, this throws the parser's plain Error.
 */
export function loadSemanticModels(
    docs: {name: string; text: string}[],
    opts: LoadOptions = {}): LoadedModels {
  const models: LoadedModel[] = [];
  const warnings: string[] = [];
  for (const doc of docs) {
    let loaded: LoadResult;
    try {
      loaded = loadModels(doc.text, {document: doc.name, ...opts});
    } catch (err) {
      if (!(err instanceof SemanticModelError)) throw err;
      return {
        models,
        warnings,
        error: `Model document '${doc.name}': ${err.message}`,
      };
    }
    for (const w of loaded.warnings) warnings.push(`[${doc.name}] ${w}`);
    for (const model of loaded.models) {
      models.push({document: doc.name, model});
    }
  }
  return {models, warnings};
}
