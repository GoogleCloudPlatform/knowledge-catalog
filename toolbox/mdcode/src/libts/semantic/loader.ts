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

import {checkDerivedRelationships, parseStep} from './derived_relationships';
import {checkGlossary} from './glossary';
import {BINDING_MODES, checkHydration, hydrationDocErrors, hydrationFromDoc, modeDocError} from './hydration';
import {Action, ActionParameter, AffectedConcept, AiContext, ALLOWED_DIALECTS, CONCEPT_OPERATIONS, Constraint, CONSTRAINT_SEVERITIES, CustomExtension, DATA_TYPES, DataType, DialectExpression, Entity, Executor, Field, Glossary, GlossaryCategory, GlossaryDefines, GlossaryTerm, isFieldBound, Metric, normalizeDataType, ProfileSpec, Relationship, relationshipAncestors, SemanticModel, SqlDialect, VIOLATION_EFFECTS, VocabularyMember} from './ir';
import {NameKind, nameProblem} from './names';
import {DeclaredConcept, declaredConceptFields} from './resolve_inheritance';
import {DEFAULT_PROFILE, fieldsOnTables, importCommand, noTextFor, profileSpecOf, sourcesDialect, TableDialects, tableDialects} from './resolve_profiles';
import {columnsForSource, entitiesReached, withoutQualifier} from './sql_expr_utils';
import {holdsNoSql, SqlColumn, withoutComments} from './sql_parser';
import {doubleQuotedNames, hasDoubleQuotedColumn} from './transpile';
import {checkUnitsAndHistory} from './units_history';
import {parseLeniently, YAML_OPTIONS} from './yaml_options';

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
  // model file, so the load gives no warning for it. A Cloud SQL, Spanner or
  // third-party table no lookup has read keeps the warning, since the caller
  // does not check it.
  fieldTextChecked?: boolean;
  // The flavor whose word for an entry of `entities` the load's messages use,
  // when it is not the document's own. kcmd import uses the word of the
  // flavor it writes.
  messageFlavor?: FormatVersion;
  defaultProject?: string;
  defaultDataset?: string;
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
    side: 'from'|'to', entity: string, word: string = 'entity'): string {
  return `'${side}' ${word} '${entity}' is not defined in the model`;
}

function sourceRequiredMessage(entity: string): string {
  return `entity '${entity}': a non-abstract entity requires a ` +
      `source; set 'source', or mark it 'abstract: true' if it has no table`;
}

function ansiFallbackNote(preferred: string): string {
  return `note: no '${
             preferred}' dialect for one or more expressions; using the portable ` +
      `'${FALLBACK_DIALECT}' dialect verbatim ('${
             preferred}' accepts the ANSI core subset — ` +
      `supply '${preferred}' variants only for ${preferred}-specific SQL)`;
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
export const DEPLOYMENTS_VERSION_HINT =
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
  readonly model:
      Placements<'profiles'|'deployments'|'actions'|'constraints'|'glossary'>;
  readonly dataset: Placements<
      'extends'|'abstract'|'defined'|'grain'|'history'|'members'|'hydration'|
      'mode'>;
  readonly field: Placements<'unit'|'scale'>;
  readonly relationship:
      Placements<'description'|'extends'|'abstract'|'inverse'|'via'|'filter'>;
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
          glossary: 'native',
        },
        dataset: {
          extends: 'native',
          abstract: 'native',
          defined: 'native',
          grain: 'native',
          history: 'native',
          members: 'native',
          hydration: 'native',
          mode: 'native',
        },
        field: {
          unit: 'native',
          scale: 'native',
        },
        relationship: {
          description: 'native',
          extends: 'native',
          abstract: 'native',
          inverse: 'native',
          via: 'native',
          filter: 'native',
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
          glossary: 'none',
        },
        dataset: {
          extends: 'block',
          abstract: 'none',
          defined: 'none',
          grain: 'none',
          history: 'none',
          members: 'none',
          hydration: 'none',
          mode: 'none',
        },
        field: {
          unit: 'none',
          scale: 'none',
        },
        relationship: {
          description: 'block',
          extends: 'none',
          abstract: 'none',
          inverse: 'none',
          via: 'none',
          filter: 'none',
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

// K7 (see units_history.ts): a dataset's history keeping. Field references are
// field names; checkUnitsAndHistory verifies they exist.
const historySchema = z.object({
                         versioned: z.boolean(),
                         current_flag: z.string().min(1).optional(),
                         valid_from: z.string().min(1).optional(),
                         valid_to: z.string().min(1).optional(),
                       }).strict();

// K3 (proposed, see vocabulary.ts): one member of a vocabulary dataset. Only
// `code` is required; it is the value the data stores and edges join on.
const memberSchema = z.object({
                        code: z.string().min(1),
                        label: z.string().optional(),
                        synonyms: z.array(z.string()).optional(),
                        definition: z.string().optional(),
                        order: z.number().int().optional(),
                        iri: z.string().optional(),
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
  // K7 unit / scale (see Field.unit / Field.scale).
  unit: z.string().optional(),
  scale: z.number().optional(),
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
  // Supertype entity names (Ossie `extends`) -- entity-level inheritance.
  // Relationships carry their own, separate `extends` (see below).
  extends: z.array(z.string()).optional(),
  // Marks a conceptual entity with no physical table (see Entity.abstract): it
  // forms no node table and survives only as a label on its concrete
  // descendants. Distinct from an unbound `source` placeholder, which must fail
  // loudly rather than be silently treated as table-less.
  abstract: z.boolean().optional(),
  // Marks a defined (virtual) entity (see Entity.definition): a membership
  // predicate over its single parent, as a bare expression string or
  // `{expression, description?}`.
  defined: z.union([
              z.string(),
              z.object({
                 expression: z.string(),
                 description: z.string().optional(),
               }),
            ]).optional(),
  // K7 grain / history (see Entity.grain / Entity.history).
  grain: z.string().optional(),
  history: historySchema.optional(),
  // K3 (proposed): the members of a vocabulary dataset (see Entity.members).
  members: z.array(memberSchema).optional(),
  // How the binding reshapes its source (see hydration.ts): a closed block
  // of rules, validated by hydrationDocErrors.
  hydration: z.any().optional(),
  mode: z.enum(BINDING_MODES).optional(),
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
                              extends: z.array(z.string()).optional(),
                              abstract: z.boolean().optional(),
                              inverse: z.string().min(1).optional(),
                              via: z.array(z.string().min(1)).min(2).optional(),
                              filter: z.string().min(1).optional(),
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

// The business glossary (`glossary`, GOOGLE_VERSION only; see glossary.ts).
// Ids follow the Dataplex resource-id rules so they publish unchanged. Every
// object is strict: a mistyped key is an error, not a silently dropped term.
const GLOSSARY_ID = /^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;
const glossaryIdSchema = z.string().regex(
    GLOSSARY_ID,
    'glossary ids use lowercase letters, digits and hyphens, start with a ' +
        'letter, end with a letter or digit, and are at most 63 characters');
// One `defines` item names exactly one model element.
const glossaryDefinesSchema = z.union([
  z.object({entity: z.string()}).strict(),
  z.object({field: z.string()}).strict(),
  z.object({metric: z.string()}).strict(),
]);
const glossarySchema = z.object({
                          id: glossaryIdSchema.optional(),
                          display_name: z.string().optional(),
                          description: z.string().optional(),
                          categories:
                              z.array(
                                   z.object({
                                      id: glossaryIdSchema,
                                      display_name: z.string().optional(),
                                      description: z.string().optional(),
                                      parent: z.string().optional(),
                                    }).strict())
                                  .optional(),
                          terms:
                              z.array(
                                   z.object({
                                      id: glossaryIdSchema,
                                      display_name: z.string().optional(),
                                      definition: z.string().optional(),
                                      category: z.string().optional(),
                                      synonyms: z.array(z.string()).optional(),
                                      related: z.array(z.string()).optional(),
                                      formula: z.string().optional(),
                                      defines:
                                          z.array(glossaryDefinesSchema).optional(),
                                      source: z.string().optional(),
                                    }).strict())
                                  .optional(),
                        }).strict();
type GlossaryDoc = z.infer<typeof glossarySchema>;

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
  glossary: glossarySchema.optional(),
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
         ...(placement.field.unit === 'native' ?
                 {unit: z.string().min(1).optional()} :
                 {}),
         ...(placement.field.scale === 'native' ?
                 {scale: z.number().positive().optional()} :
                 {}),
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
         ...(placement.dataset.defined === 'native' ? {
           defined: z.union([
                       z.string().min(1),
                       z.object({
                          expression: z.string().min(1),
                          description: z.string().optional(),
                        }).strict(),
                     ]).optional(),
         } :
                                                      {}),
         ...(placement.dataset.grain === 'native' ?
                 {grain: z.string().min(1).optional()} :
                 {}),
         ...(placement.dataset.history === 'native' ?
                 {history: historySchema.optional()} :
                 {}),
         ...(placement.dataset.members === 'native' ?
                 {members: z.array(memberSchema).optional()} :
                 {}),
         ...(placement.dataset.hydration === 'native' ?
                 {hydration: z.unknown().optional()} :
                 {}),
         ...(placement.dataset.mode === 'native' ?
                 {mode: z.unknown().optional()} :
                 {}),
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
            const defined =
                placement.dataset.defined === 'native' &&
                ds.defined !== undefined;
            const vocabulary =
                placement.dataset.members === 'native' &&
                ds.members !== undefined;
            const derived =
                placement.dataset.hydration === 'native' &&
                isRecord(ds.hydration) &&
                ds.hydration.derive_from !== undefined;
            if (extended && ds.hydration !== undefined) {
              for (const message of hydrationDocErrors(ds.hydration)) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  path: ['hydration'],
                  message: `entity '${ds.name}': ${message}`,
                });
              }
            }
            if (extended && ds.mode !== undefined) {
              const message = modeDocError(ds.mode);
              if (message) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  path: ['mode'],
                  message: `entity '${ds.name}': ${message}`,
                });
              }
            }
            // In the Google flavor, a concrete (non-abstract) dataset must name
            // its backing table; only an abstract, defined, derived or
            // vocabulary one may omit `source`. Relaxed under bindingOptional.
            // Vanilla has no `abstract` and requires `source` unconditionally
            // (see requireVanillaBindings).
            if (extended && !bindingOptional && !abstract && !defined &&
                !vocabulary && !derived && ds.source === undefined) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['source'],
                message: sourceRequiredMessage(ds.name),
              });
            }
            // The converse is always contradictory: an abstract dataset has no
            // physical table, so a `source` on it would be silently ignored.
            // Reject it always. (A defined one gets its own message below.)
            if (abstract && !defined && ds.source !== undefined) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['source'],
                message:
                    `entity '${ds.name}': an abstract entity has no table; ` +
                    `remove 'source', or drop 'abstract: true' to bind it to that table`,
              });
            }
            // A defined entity is a filter over its parent's rows: it has no
            // table and no identity of its own (it shares the parent's).
            if (defined) {
              for (const key of ['source', 'primary_key', 'unique_keys']) {
                if (ds[key] === undefined) continue;
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  path: [key],
                  message: `entity '${ds.name}': a defined dataset is a ` +
                      `subset of its parent and has no ${key} of its own; ` +
                      `remove '${key}', or drop 'defined' to bind it to a table`,
                });
              }
            }
            // K3: a vocabulary's members are its rows, which an abstract or
            // defined dataset does not have of its own.
            if (vocabulary && (abstract || defined)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['members'],
                message: `entity '${ds.name}': 'members' lists a ` +
                    `vocabulary's rows, which ${
                        abstract ? 'an abstract' : 'a defined'} entity does ` +
                    `not have; remove 'members' or '${
                        abstract ? 'abstract' : 'defined'}'`,
              });
            }
            // Edges match a code case-insensitively, so two codes differing
            // only in case would be one member.
            const seen = new Map<string, string>();
            for (const m of (ds.members ?? []) as Array<{code: string}>) {
              const k = m.code.toLowerCase();
              if (seen.has(k)) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  path: ['members'],
                  message: `entity '${ds.name}': member code '${
                      m.code}' repeats '${seen.get(k)}' (codes are matched ` +
                      `case-insensitively and must be unique)`,
                });
              }
              seen.set(k, m.code);
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
         ...(placement.relationship.inverse === 'native' ?
                 {inverse: z.string().min(1).optional()} :
                 {}),
         ...customExtensionsKey,
         ...(placement.relationship.extends === 'native' ?
                 {extends: z.array(z.string()).optional()} :
                 {}),
         ...(placement.relationship.abstract === 'native' ?
                 {abstract: z.boolean().optional()} :
                 {}),
         ...(placement.relationship.via === 'native' ?
                 {via: z.array(z.string().min(1)).min(2).optional()} :
                 {}),
         ...(placement.relationship.filter === 'native' ?
                 {filter: z.string().min(1).optional()} :
                 {}),
       })
          .strict()
          .superRefine((r: any, ctx) => {
            if ((r.from_columns === undefined) !==
                (r.to_columns === undefined)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: halfBoundJoinMessage(r.name),
              });
            }
            if (r.abstract === true && r.from_columns !== undefined) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `relationship '${
                             r.name}': an abstract relationship has no edge ` +
                    `table, so it binds no join columns; remove ` +
                    `from_columns/to_columns, or drop 'abstract: true'.`,
              });
            }
            const inverse = (r as {inverse?: string}).inverse;
            if (inverse !== undefined && inverse === r.name) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['inverse'],
                message: `relationship '${r.name}': 'inverse' names the ` +
                    `relationship itself; an inverse is the edge read the ` +
                    `other way and needs its own name`,
              });
            }
            if (r.via !== undefined && r.from_columns !== undefined) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['via'],
                message: `relationship '${r.name}': a derived relationship ` +
                    `('via') takes its pairs from the chain and binds no ` +
                    `join columns; remove from_columns/to_columns or 'via'`,
              });
            }
            if (r.via !== undefined && r.abstract === true) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['via'],
                message: `relationship '${r.name}': a derived relationship ` +
                    `('via') has edges and cannot be abstract; remove ` +
                    `'abstract' or 'via'`,
              });
            }
            for (const step of (r.via ?? []) as string[]) {
              if (step.replace(/^\s*\^/, '').trim() === r.name) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  path: ['via'],
                  message: `relationship '${r.name}': 'via' step '${
                      step}' names the relationship itself`,
                });
              }
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
    ...(placement.model.glossary === 'native' ?
            {glossary: glossarySchema.optional()} :
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

export function googleBlockProfiles(text: string): ProfileSpec[] {
  let doc: unknown;
  try {
    doc = yaml.parse(text, YAML_OPTIONS);
  } catch (err: any) {
    return googleBlockProfilesPastYamlError(text, err?.message ?? String(err));
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

function versionPastYamlError(
    parsed: yaml.Document.Parsed, errors: yaml.YAMLError[]): string|undefined {
  const version = onlyValue(parsed.contents, 'version');
  if (!yaml.isScalar(version) || typeof version.value !== 'string' ||
      errors.some(err => err.code !== 'DUPLICATE_KEY')) {
    return undefined;
  }
  return version.value;
}

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

export function loadModels(text: string, opts: LoadOptions = {}): LoadResult {
  let doc: unknown;
  try {
    doc = yaml.parse(text, YAML_OPTIONS);
  } catch (err: any) {
    throw new SemanticModelError(
        `Semantic model load error: could not parse input: ${
            err?.message ?? err}`);
  }
  return fromDocument(doc, opts);
}

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
// `preferred`. pickDialect picks by this and expressionWarning warns by it, so
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

// A field or metric as a warning names it in `ctx`. A metric reads fields as
// `entity.field`.
interface Subject {
  ctx: string;
  metric: boolean;
}

// The warning `item` gives on a table of `dialect`, in capitals, or undefined
// when it has text in that dialect. That is the double-quote warning on a
// dialect in DOUBLE_QUOTES_AS_TEXT, and otherwise the transpilation warning or
// the ANSI_SQL note, which only the `preferred` dialect gives, and never for
// the string form.
function expressionWarning(
    item: Pick<Field, 'dialects'|'stringForm'>, subject: Subject,
    dialect: string, preferred: string): string|undefined {
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
  if (fallsBackToAnsi(dialects, preferred)) return ansiFallbackNote(preferred);
  const vendor = dialects.find(d => d.dialect !== FALLBACK_DIALECT);
  return `${ctx}: no '${preferred}' or '${
             FALLBACK_DIALECT}' dialect; keeping the '${vendor?.dialect}' ` +
      `expression as imported_expression (needs transpilation to '${
             preferred}')`;
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
// the table has no text to run. With `profiled`, the second is given only on a
// Cloud SQL, Spanner or third-party table no lookup has read. On a table of the
// `preferred` dialect, expressionWarning's transpilation warning already says
// so.
function tableWarning(
    item: Pick<Field, 'expression'|'dialects'|'stringForm'>, subject: Subject,
    table: TableDialects, entity: string, preferred: string,
    profiled: boolean): string|undefined {
  const w = table.unread ?
      undefined :
      expressionWarning(item, subject, table.name, preferred);
  if (w || (profiled && !table.unread && !table.guessed) ||
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
    model: SemanticModel, preferred: string, profiled: boolean): string[] {
  return fieldsOnTables(model, true)
      .map(({entity: e, field: f, table}) => tableWarning(
               f, {ctx: `field '${e.name}.${f.name}'`, metric: false}, table,
               e.name, preferred, profiled))
      .filter((w): w is string => w !== undefined);
}

// The warning `metric`'s expression gives on the tables of the `reached`
// entities, in that order, or on every table when it reaches none. On a table
// of the `preferred` dialect it is expressionWarning's; otherwise it is the
// first tableWarning a table gives.
function metricWarning(
    metric: Pick<Metric, 'name'|'expression'|'dialects'|'stringForm'>,
    reached: ReadonlyArray<string|undefined>, entities: ReadonlyArray<Entity>,
    preferred: string, profiled: boolean): string|undefined {
  const subject = {ctx: `metric '${metric.name}'`, metric: true};
  const named =
      entities.filter(e => reached.includes(e.name))
          .sort((a, b) => reached.indexOf(a.name) - reached.indexOf(b.name));
  const tables = named.length ? named : entities;
  if (tables.some(e => runsDialect(e, preferred))) {
    return expressionWarning(
        metric, subject, preferred.toUpperCase(), preferred);
  }
  for (const e of tables) {
    const table = tableDialects(e, true);
    const w = table &&
        tableWarning(metric, subject, table, e.name, preferred, profiled);
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

// Every warning a load gives about `model`'s entities and metrics, in the
// order a load gives them: each field's expression warning, then each metric's
// expression warning and its warning when it names no entity. A metric a
// profile excludes gives none. With `profiled`, the profile check reports a
// field or metric its tables cannot run, so no warning repeats it. A profile
// changes only these; a load's other warnings, about actions, come after them.
export function entityAndMetricWarnings(
    model: SemanticModel, preferred: string = DEFAULT_DIALECT,
    profiled = false): string[] {
  const entities = model.entities ?? [];
  const out = fieldWarnings(model, preferred, profiled);
  const entityNames = entities.map(e => e.name);
  const impliedDialect = sourcesDialect(model);
  const excluded = new Set(model.excludedMetrics);
  for (const m of model.metrics ?? []) {
    if (excluded.has(m.name)) continue;
    const {referenced, warning: mw} = inferMetricEntities(
        m, entityNames, preferred, impliedDialect, model.version);
    const w = metricWarning(
        m, [m.authoredEntity, ...referenced], entities, preferred, profiled);
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
  warnRelationshipInheritance(entities, relationships, warnings);
  // K2: a derived relationship's chain that does not resolve or connect loads
  // with a warning; a graph leg omits the edge (see derived_relationships.ts).
  const k2: string[] = [];
  checkDerivedRelationships(entities, relationships, k2);
  for (const msg of k2) warnings.push(`model '${m.name}': ${msg}`);
  // An inverse name is a second graph element name for the same edge (its
  // own edge table and label on a push), so it shares the element namespace:
  // it must differ from every dataset, relationship, and other inverse.
  const elementNames =
      new Set([...entityNames, ...relationships.map(r => r.name)].map(
          n => n.toLowerCase()));
  for (const r of relationships) {
    if (!r.inverse) continue;
    rejectInvalidName('relationship', r.inverse, `model '${m.name}'`);
    const key = r.inverse.toLowerCase();
    if (elementNames.has(key)) {
      throw new SemanticModelError(
          `model '${m.name}': relationship '${r.name}' has inverse '${
              r.inverse}', which repeats the name of ${
              word === 'entity' ? 'an entity' : 'a dataset'}, relationship, ` +
          `or another inverse; graph element names must be unique.`);
    }
    elementNames.add(key);
  }

  // A field is judged on each entity that inherits it too, so its warning
  // waits until every entity is read.
  warnings.push(...fieldWarnings(
      {name: m.name, entities, relationships, metrics: []}, dialect,
      !!opts.fieldTextChecked));
  const impliedDialect = sourcesDialect({entities});
  const metrics = (m.metrics ?? []).map(
      mt => convertMetric(
          mt, version, entities, warnings, dialect, word, impliedDialect));
  rejectDuplicateNames(
      metrics.map(mt => mt.name), 'metric name', `model '${m.name}'`, true);

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
  const seenTargets = new Map<string, string>();
  for (const d of deployments) {
    const first = seenTargets.get(d.target);
    if (first !== undefined) {
      throw new SemanticModelError(
          `Semantic model load error: model '${m.name}': deployments '${
              first}' and '${d.name}' target the same resource '${
              d.target}'; each deployment must target a distinct resource`);
    }
    seenTargets.set(d.target, d.name);
  }

  const description = composeDescription(m.description);

  // `version` records the flavor the document was written in, so a consumer
  // (e.g. a pull) can return the model in that same flavor.
  const model: SemanticModel =
      {name: m.name, version, entities, relationships, metrics};
  if (actions.length) model.actions = actions;
  if (constraints.length) model.constraints = constraints;
  if (deployments.length) model.deployments = deployments;
  if (block.values.profiles?.length) model.profiles = block.values.profiles;
  if (description) model.description = description;
  const ai = aiContextOrUndefined(m.ai_context);
  if (ai) model.aiContext = ai;
  // The blocks the model keeps are carried verbatim.
  if (block.kept) model.customExtensions = block.kept;
  // K7: a history key naming no field (or a non-Boolean current_flag) loads
  // with a warning; validatePushRequirements rejects the missing field.
  const k7 = checkUnitsAndHistory(model);
  for (const msg of [...k7.errors, ...k7.warnings]) {
    warnings.push(`model '${m.name}': ${msg}`);
  }
  // Hydration: a rule naming no field / relationship loads with a warning;
  // validatePushRequirements rejects it (see hydration.ts checkHydration).
  const hyd = checkHydration(model);
  for (const msg of [...hyd.errors, ...hyd.warnings]) {
    warnings.push(`model '${m.name}': ${msg}`);
  }
  // K9: the business glossary. Unresolved references load with a warning;
  // validatePushRequirements rejects them (see glossary.ts checkGlossary).
  if (m.glossary !== undefined) {
    model.glossary = convertGlossary(m.glossary);
    const k9 = checkGlossary(model);
    for (const msg of [...k9.errors, ...k9.warnings]) {
      warnings.push(`model '${m.name}': ${msg}`);
    }
  }
  return model;
}

// The snake_case `glossary` block -> the camelCase IR (see ir.ts Glossary).
// Absent optional keys stay absent so a serializer round-trips the block.
function convertGlossary(g: GlossaryDoc): Glossary {
  const out: Glossary = {categories: [], terms: []};
  if (g.id !== undefined) out.id = g.id;
  if (g.display_name !== undefined) out.displayName = g.display_name;
  if (g.description !== undefined) out.description = g.description;
  for (const c of g.categories ?? []) {
    const cat: GlossaryCategory = {id: c.id};
    if (c.display_name !== undefined) cat.displayName = c.display_name;
    if (c.description !== undefined) cat.description = c.description;
    if (c.parent !== undefined) cat.parent = c.parent;
    out.categories.push(cat);
  }
  for (const t of g.terms ?? []) {
    const term: GlossaryTerm = {id: t.id};
    if (t.display_name !== undefined) term.displayName = t.display_name;
    if (t.definition !== undefined) term.definition = t.definition;
    if (t.category !== undefined) term.category = t.category;
    if (t.synonyms?.length) term.synonyms = [...t.synonyms];
    if (t.related?.length) term.related = [...t.related];
    if (t.formula !== undefined) term.formula = t.formula;
    if (t.defines?.length) {
      term.defines = t.defines.map((d): GlossaryDefines => {
        if ('entity' in d) return {kind: 'entity', ref: d.entity};
        if ('field' in d) return {kind: 'field', ref: d.field};
        return {kind: 'metric', ref: d.metric};
      });
    }
    if (t.source !== undefined) term.source = t.source;
    out.terms.push(term);
  }
  return out;
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
  let definition: Entity['definition'];
  if (typeof ds.defined === 'string') {
    definition = {expression: ds.defined};
  } else if (ds.defined !== undefined) {
    definition = {expression: ds.defined.expression};
    if (ds.defined.description !== undefined) {
      definition.description = ds.defined.description;
    }
  }
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
  if (definition) {
    entity.definition = definition;
    if (ds.abstract) {
      warnings.push(`${
          ctxLabel}: 'abstract: true' is ignored on a defined ${
          word} (it is a subset of its parent, not a supertype)`);
    }
  } else if (ds.abstract) {
    entity.abstract = true;
  }
  if (ds.grain !== undefined) entity.grain = ds.grain;
  if (ds.history !== undefined) {
    const history: Entity['history'] = {versioned: ds.history.versioned};
    if (ds.history.current_flag !== undefined) {
      history.currentFlag = ds.history.current_flag;
    }
    if (ds.history.valid_from !== undefined) {
      history.validFrom = ds.history.valid_from;
    }
    if (ds.history.valid_to !== undefined) {
      history.validTo = ds.history.valid_to;
    }
    entity.history = history;
  }
  if (ds.members !== undefined) {
    entity.members = ds.members.map(m => {
      const member: VocabularyMember = {code: m.code};
      if (m.label !== undefined) member.label = m.label;
      if (m.synonyms?.length) member.synonyms = m.synonyms;
      if (m.definition !== undefined) member.definition = m.definition;
      if (m.order !== undefined) member.order = m.order;
      if (m.iri !== undefined) member.iri = m.iri;
      return member;
    });
  }
  if (ds.hydration !== undefined && ds.hydration !== null) {
    const hydration = hydrationFromDoc(ds.hydration);
    if (Object.keys(hydration).length) entity.hydration = hydration;
  }
  if (ds.mode !== undefined) entity.mode = ds.mode;
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

export function parseFieldExpression(
    raw: unknown, where: string, dialect: string,
    entity: string): FieldExpression {
  return readFieldExpression(
      raw, where, dialect, doc => noSqlProblem(doc, entity));
}

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
  const description = composeDescription(f.description);
  const ctx = `field '${entityName}.${f.name}'`;

  const field: Field = {name: f.name};
  if (f.expression !== undefined) {
    Object.assign(field, fieldExpression(f.expression, version, dialect, ctx));
  }
  const type = resolveDataType(f.datatype, version, ctx);
  if (type) field.type = type;
  if (f.unit !== undefined) field.unit = f.unit;
  if (f.scale !== undefined) field.scale = f.scale;
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
  if (r.extends && r.extends.length) relationship.extends = r.extends;
  if (r.abstract) relationship.abstract = true;
  const block =
      readGoogleBlocks(r.custom_extensions, version, 'relationship', ctx);
  const description =
      composeDescription(r.description ?? block.values.description);
  if (description) relationship.description = description;
  const ai = aiContextOrUndefined(r.ai_context);
  if (ai) relationship.aiContext = ai;
  if (r.inverse !== undefined) relationship.inverse = r.inverse;
  if (r.via !== undefined) relationship.via = r.via.map(parseStep);
  if (r.filter !== undefined) relationship.filter = r.filter;
  if (block.kept) relationship.customExtensions = block.kept;
  return relationship;
}

// Lint pass over relationship inheritance, run once the model's relationships
// are known. Everything here is a WARNING, never a throw.
function warnRelationshipInheritance(
    entities: Entity[], relationships: Relationship[],
    warnings: string[]): void {
  const byName = new Map(relationships.map(r => [r.name, r]));
  const entityByName = new Map(entities.map(e => [e.name, e]));
  const lineage = (name: string): Set<string> => {
    const out = new Set<string>();
    const queue = [name];
    while (queue.length) {
      const n = queue.shift()!;
      if (out.has(n)) continue;
      out.add(n);
      queue.push(...(entityByName.get(n)?.extends ?? []));
    }
    return out;
  };
  for (const r of relationships) {
    const ctx = `relationship '${r.name}'`;
    for (const p of r.extends ?? []) {
      const parent = byName.get(p);
      if (!parent) {
        warnings.push(`${ctx}: extends '${
            p}', which is not a relationship in the model`);
        continue;
      }
      if (!lineage(r.source.entity).has(parent.source.entity)) {
        warnings.push(`${ctx}: source '${r.source.entity}' is not '${
            parent.source.entity}' or a subtype of it, so its edges do not ` +
                      `fit the '${p}' label it extends`);
      }
      if (!lineage(r.destination.entity).has(parent.destination.entity)) {
        warnings.push(`${ctx}: destination '${
            r.destination.entity}' is not '${
            parent.destination.entity}' or a subtype of it, so its edges do ` +
                      `not fit the '${p}' label it extends`);
      }
    }
    if (relationshipAncestors(relationships, r.name).some(
            a => (byName.get(a)?.extends ?? []).includes(r.name))) {
      warnings.push(`${ctx}: its 'extends' chain is cyclic (it is its own ` +
                    `ancestor); break the cycle`);
    }
  }
}

function convertMetric(
    mt: MetricDoc, version: FormatVersion, entities: Entity[],
    warnings: string[], dialect: string, word: string,
    impliedDialect?: string|null): Metric {
  rejectInvalidName('metric', mt.name);
  const ctx = `metric '${mt.name}'`;
  const entityNames = entities.map(e => e.name);
  const block = readGoogleBlocks(mt.custom_extensions, version, 'metric', ctx);
  const authored = mt.entity ?? block.values.entity;
  const {dialects, stringForm, picked} =
      convertExpression(mt.expression, version, dialect, ctx);
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
      {name: mt.name, dialects, stringForm}, [authored, ...referenced],
      entities, dialect, false);
  if (ew) warnings.push(ew);
  if (mw) warnings.push(mw);
  const metric: Metric = {name: mt.name, dialects, stringForm};
  if (authored !== undefined) {
    if (!entityNames.includes(authored)) {
      throw new SemanticModelError(
          `Semantic model load error: ${ctx}: 'entity' names '${authored}', ` +
          `which is not ${word === 'entity' ? 'an' : 'a'} ${word} in this ` +
          `model.`);
    }
    metric.authoredEntity = authored;
    metric.entity = authored;
  } else if (referenced.length === 1) {
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

function convertAction(
    a: ActionDoc, concepts: Map<string, DeclaredConcept>,
    entityNames: Set<string>, relationshipNames: Set<string>,
    warnings: string[], inheritanceResolved = true): Action {
  const parameters =
      (a.parameters ?? [])
          .map(
              p => convertParameter(
                  p, a.name, concepts, warnings, inheritanceResolved));
  rejectDuplicateNames(
      parameters.map(p => p.name), 'parameter name', `action '${a.name}'`);

  const action: Action = {
    name: a.name,
    parameters,
  };
  if (a.executor != null) {
    action.executor = convertExecutor(a.executor);
  }
  if (a.guards?.length) {
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
      rejectDuplicateNames(
          e.fields, 'affected field',
          `action '${actionName}' affects '${concept}'`);
      affected.fields = [...e.fields];
    }
  }
  return affected;
}

function rejectDuplicateAffectedConcepts(
    affects: AffectedConcept[], actionName: string): void {
  rejectDuplicateNames(
      affects.map(e => `${e.concept}/${e.operation ?? '(unspecified)'}`),
      'affected concept', `action '${actionName}'`);
}

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
    warnings.push(`${where}: parameter '${name}' projects field '${
        fieldName}', which ${concept!.kind} '${
        conceptName}' does not declare.`);
  }

  if (field?.type !== undefined) param.type = field.type;
  if (statedType !== undefined) param.type = statedType;
  const description = p.description ?? field?.description;
  if (description !== undefined) param.description = description;
  const label = p.label ?? field?.label;
  if (label !== undefined) param.label = label;
  const ai = aiContextOrUndefined(p.ai_context) ?? field?.aiContext;
  if (ai) param.aiContext = ai;
  if (p.required !== undefined) param.required = p.required;
  if (p.default !== undefined) param.default = p.default;

  if (param.type === undefined) {
    if (!hasConcept) {
      warnings.push(
          `${where}: parameter '${name}' states no 'type' and projects no ` +
          `field. A parameter with no field behind it declares its own ` +
          `scalar type (${DATA_TYPES.join('/')}).`);
    } else if (field && inheritanceResolved) {
      warnings.push(
          `${where}: parameter '${name}' projects field '${conceptName}.${
              fieldName}', which declares no datatype, so the parameter has ` +
          `none either. Give that field a scalar type (${
              DATA_TYPES.join('/')}).`);
    }
  } else if (!(DATA_TYPES as readonly string[]).includes(param.type)) {
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

export function formatIssues(issues: readonly z.ZodIssue[]): string {
  return issues
      .map(i => (i.path.length ? `${i.path.join('.')}: ` : '') + i.message)
      .join('; ');
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

interface SchemaInput {
  schema: z.ZodType;
  doc: unknown;
  authored: unknown;
  extended: boolean;
  subject: string;
  words?: FormatVersion;
}

const ENTRY_NOUNS = new Map([
  ['semantic_model', 'model'], ['datasets', 'dataset'], ['fields', 'field'],
  ['relationships', 'relationship'], ['metrics', 'metric'],
  ['actions', 'action'], ['parameters', 'parameter'],
  ['constraints', 'constraint'], ['deployments', 'deployment'],
  ['categories', 'category'], ['terms', 'term'],
]);

const EXPECTED: Record<string, string> = {
  string: 'a string',
  boolean: 'true or false',
  array: 'a list',
  object: 'a mapping',
  record: 'a mapping',
};

function described(value: unknown): string {
  if (value === undefined) return 'missing';
  if (value === null) return 'empty';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'object') return 'a mapping';
  if (typeof value !== 'string') return String(value);
  return value.includes('\n') ? 'a string' : `'${value}'`;
}

function keysAt(schema: z.ZodType, path: readonly PropertyKey[]): string[] {
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
    name = typeof node?.name === 'string' ? node.name :
        typeof node?.id === 'string'      ? node.id :
                                            undefined;
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

function schemaProblems(
    issues: readonly SchemaIssue[], input: SchemaInput): string {
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
      if (name !== undefined && issue.message.includes(`'${name}'`)) {
        return issue.message;
      }
      return `${subject}: ${issue.message}`;
  }
  return `${at}: ${issue.message}`;
}

export function parseExecutor(raw: unknown, where: string): Executor {
  const result = executorSchema.safeParse(raw);
  if (!result.success) {
    throw new SemanticModelError(
        keyProblems(result.error, executorSchema, 'executor', raw, where));
  }
  return convertExecutor(result.data);
}

function convertExecutor(ex: ExecutorDoc): Executor {
  if (ex.mcp) return {kind: 'mcp', mcp: {...ex.mcp}};
  if (ex.rest) return {kind: 'rest', rest: {...ex.rest}};
  if (ex.sql) {
    return {
      kind: 'sql',
      sql: {statements: ex.sql.statements.map(t => t.trim())},
    };
  }
  return {kind: 'grpc', grpc: {...ex.grpc!}};
}

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

  return out;
}

interface ParsedSource {
  dataSource: string;
  authoredSource: string;
  sourceDialect?: string;
}

const MAX_CATALOG_NAME_LENGTH = 4000;

const BIGQUERY_TABLE_URI =
    /^\/\/bigquery\.googleapis\.com\/projects\/([^/]+)\/datasets\/([^/.]+)\/tables\/([^/.]+)$/;
const BIGLAKE_TABLE_URI =
    /^\/\/biglake\.googleapis\.com\/projects\/([^/]+)\/catalogs\/([^/.]+)\/(namespaces|databases)\/([^/.]+)\/tables\/([^/.]+)$/;
const SPANNER_TABLE_URI =
    /^\/\/spanner\.googleapis\.com\/projects\/([^/]+)\/instances\/([^/]+)\/databases\/([^/]+)\/tables\/[^/]+$/;
const ALLOYDB_TABLE_URI =
    /^\/\/alloydb\.googleapis\.com\/projects\/([^/]+)\/locations\/([^/]+)\/clusters\/([^/]+)\/databases\/([^/]+)\/schemas\/[^/]+\/tables\/[^/]+$/;
const LEGACY_ALLOYDB_INSTANCE_URI =
    /^\/\/alloydb\.googleapis\.com\/projects\/([^/]+)\/locations\/([^/]+)\/clusters\/([^/]+)\/instances\/[^/]+\/databases\/([^/]+)\/tables\/([^/]+)$/;
const CLOUDSQL_TABLE_URI =
    /^\/\/cloudsql\.googleapis\.com\/projects\/([^/]+)\/locations\/([^/]+)\/instances\/([^/]+)\/databases\/[^/]+\/tables\/[^/]+$/;
const CLOUDSQL_SCHEMA_TABLE_URI =
    /^\/\/cloudsql\.googleapis\.com\/projects\/([^/]+)\/locations\/([^/]+)\/instances\/([^/]+)\/databases\/([^/]+)\/schemas\/[^/]+\/tables\/[^/]+$/;

const QUOTE = /["`]/;

export interface CloudSqlTable {
  project: string;
  location: string;
  instance: string;
  resourceName: string;
  inSchema: boolean;
}

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

export type SourceTable = {resourceName: string; project: string}&(
    {system: 'bigquery'; dataset: string; table: string}|
    {system: 'biglake'; catalog: string; hive: boolean}|
    {system: 'spanner'; instance: string}|
    {system: 'alloydb'; location: string});

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

const RESOURCE_NAME = /^[a-z][a-z0-9-]*\.googleapis\.com\//;

export function asResourceUri(value: string): string {
  return RESOURCE_NAME.test(value) ? `//${value}` : value;
}

export function asResourceName(value: string): string {
  const name = value.replace(/^\/\//, '');
  return RESOURCE_NAME.test(name) ? name : value;
}

export function resourceUriFix(uri: string): string {
  return `a resource URI; write its GCP resource name, without the leading ` +
      `'//': '${asResourceName(uri)}'`;
}

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

export const NO_SPACE =
    "a source can hold a space in the table's own name, but not at its end";

export const AROUND_WHITESPACE = 'begins or ends with whitespace; remove it';

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

const FORM_USES: Record<string, string> = {
  cloudsql: 'MySQL',
  cloudsqlSchema: 'PostgreSQL, SQL Server',
  biglake: 'Iceberg REST catalog',
  biglakeHive: 'Hive catalog',
};

export function fillForm(form: string, parts: string[]): string|undefined {
  const skip = (form.match(/<\w+>/g) ?? []).length - parts.length;
  if (skip < 0) return undefined;
  let n = 0;
  return form.replace(
      /<\w+>/g, name => n++ < skip ? name : parts[n - 1 - skip]);
}

const SERVICE_NAMES: Record<string, string> = {
  bigquery: 'BigQuery',
  biglake: 'BigLake',
  spanner: 'Spanner',
  alloydb: 'AlloyDB',
  cloudsql: 'Cloud SQL',
};

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

function catalogNameResourceName(fqn: string): string|undefined {
  const form = CATALOG_NAME_FORMS.find(([prefix]) => fqn.startsWith(prefix));
  if (!form || fqn.length > MAX_CATALOG_NAME_LENGTH) return undefined;
  const [prefix, count, resourceName] = form;
  const segs = catalogNameSegments(fqn.slice(prefix.length));
  if (segs.length !== count || segs.some(seg => seg === '')) return undefined;
  return resourceName(segs);
}

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

export function hasUnquotedWhitespace(source: string): boolean {
  const text = withoutTableNameSpaces(source);
  let from = 0;
  for (const [open, close] of quotePairs(text)) {
    if (/\s/.test(text.slice(from, open))) return true;
    from = close + 1;
  }
  return /\s/.test(text.slice(from));
}

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

export function databaseOf(written: string): string|undefined {
  if (hasUnquotedWhitespace(written)) return undefined;
  const source = asResourceUri(written);
  if (BIGQUERY_TABLE_URI.test(source) || BIGLAKE_TABLE_URI.test(source)) {
    return 'bigquery';
  }
  let m = source.match(SPANNER_TABLE_URI);
  if (m) return `spanner/${m[1]}/${m[2]}/${m[3]}`;
  m = source.match(ALLOYDB_TABLE_URI);
  if (m) return `alloydb/${m[1]}/${m[2]}/${m[3]}/${m[4]}`;
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

export function isAcceptedSource(source: string|undefined): boolean {
  return source !== undefined && databaseOf(source) !== undefined;
}

export function writtenSource(
    entity: {authoredSource?: string; dataSource?: string}): string {
  const authored = entity.authoredSource?.trim();
  return authored !== undefined && isAcceptedSource(authored) ?
      authored :
      asResourceName(entity.dataSource ?? '');
}

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

export const DIALECT_OF_ENTRY_TYPE: Record<string, string> = {
  'cloudsql-mysql-table': 'MYSQL',
  'cloudsql-mysql-view': 'MYSQL',
  'cloudsql-postgresql-table': 'POSTGRES',
  'cloudsql-postgresql-view': 'POSTGRES',
  'cloudsql-sqlserver-table': 'SQLSERVER',
  'cloudsql-sqlserver-view': 'SQLSERVER',
};

export const DIALECT_OF_FQN_PREFIX = new Map([
  ['snowflake', 'SNOWFLAKE'], ['databricks', 'DATABRICKS'], ['mysql', 'MYSQL'],
  ['postgresql', 'POSTGRES'], ['sqlserver', 'SQLSERVER'],
]);
const ENTRY_NAME =
    /^projects\/[^/]+\/locations\/[^/]+\/entryGroups\/([^/]+)\/entries\/(.+)$/;
export const ENTRY_NAME_FORM =
    'projects/<p>/locations/<l>/entryGroups/<g>/entries/<id>';
export const THIRD_PARTY_SOURCE = 'A table outside Google Cloud is written ' +
    `as the entry name of its Knowledge Catalog entry, '${ENTRY_NAME_FORM}'.`;

export interface ThirdPartyEntry {
  project: string;
  location: string;
  name: string;
}

export function thirdPartyEntryOf(source: string): ThirdPartyEntry|undefined {
  const name = source.trim();
  const m = name.match(ENTRY_NAME);
  if (!m || m[1].startsWith('@') || QUOTE.test(name)) return undefined;
  const [, project, , location] = name.split('/');
  return {project, location, name};
}

export function bindsThirdPartyTable(
    entity: {authoredSource?: string}): boolean {
  return thirdPartyEntryOf(entity.authoredSource ?? '') !== undefined;
}

export function dialectLookupKey(source: string): string|undefined {
  return cloudSqlTableOf(source)?.resourceName ??
      thirdPartyEntryOf(source)?.name ?? spannerDatabaseOf(source);
}

export function spannerDatabaseOf(source: string): string|undefined {
  const uri = asResourceUri(source.trim());
  return !QUOTE.test(uri) && SPANNER_TABLE_URI.test(uri) ?
      uri.slice(2, uri.lastIndexOf('/tables/')) :
      undefined;
}

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

const UNSUPPORTED_SERVICES:
    Array<{name: string; host: string; prefix: string}> = [
  {name: 'Bigtable', host: 'bigtable.googleapis.com', prefix: 'bigtable:'},
  {
    name: 'Dataproc Metastore',
    host: 'metastore.googleapis.com',
    prefix: 'dataproc_metastore:',
  },
];

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

export function isGoogleCloudForm(source: string): boolean {
  const system = source.match(/^([a-z_]+):/)?.[1];
  return RESOURCE_NAME.test(source.replace(/^\/\//, '')) ||
      [...CATALOG_NAME_FORMS.map(([p]) => p),
       ...UNSUPPORTED_SERVICES.map(s => s.prefix)]
          .some(p => p.startsWith(`${system}:`)) ||
      !!source.match(ENTRY_NAME)?.[1].startsWith('@');
}

function thirdPartyNameError(source: string, ctx: string): string|undefined {
  return DIALECT_OF_FQN_PREFIX.has(source.match(/^([a-z]+):/)?.[1] ?? '') ?
      `Semantic model load error: ${ctx}: source '${source}' is a ` +
          `Knowledge Catalog name; write the entry name of the table's ` +
          `Knowledge Catalog entry instead, such as '${ENTRY_NAME_FORM}'.` :
      undefined;
}

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

  const isBareTableName = trimmed.length > 0 && !trimmed.includes('/') &&
      !trimmed.includes(':');
  let dotted: string|undefined;
  if (isBareTableName) {
    const viaImport = importVersion ?
        `\nOr run '${
            importCommand('--source-prefix <prefix>', importVersion)}' to ` +
            `complete each bare table name from the database or Knowledge ` +
            `Catalog entry group that <prefix> names.` :
        '';
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

export function bareNameSegments(name: string, bigQuery: boolean): string[] {
  return bareNameParts(name, bigQuery).map(p => p.text);
}

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


export interface LoadedModel {
  document: string;
  model: SemanticModel;
}

export interface LoadedModels {
  models: LoadedModel[];
  warnings: string[];
  error?: string;
}

export function loadSemanticModels(
    docs: {name: string; text: string}[],
    opts: LoadOptions = {}): LoadedModels {
  const models: LoadedModel[] = [];
  const warnings: string[] = [];
  for (const doc of docs) {
    let loaded: LoadResult;
    try {
      loaded = loadModels(doc.text, opts);
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
