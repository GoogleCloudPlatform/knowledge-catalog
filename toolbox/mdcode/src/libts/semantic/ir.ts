// Defines the Semantic Model intermediate representation (IR).
//
// The IR is the in-memory contract for a semantic model. It represents
// semantics only: a graph of entities (nodes) connected by relationships
// (edges), plus model-level metrics.
//

/**
 * AI-first annotations, from the open format's `ai_context`.
 *
 * The format allows either a bare instructions string (shorthand) or a
 * structured object; the loader normalizes both to this one shape, so the IR
 * always sees the structured form. The parts are grouped in a single object
 * (mirroring the format, e.g. Apache Ossie's `ai_context`) rather than scattered
 * as sibling fields, so nothing is lost and an emitter can still route each part
 * to its own destination (e.g. `instructions` -> a Guidelines aspect,
 * `synonyms` -> glossary links).
 */
export interface AiContext {
  // Free-form guidance for AI consumers.
  instructions?: string;
  // Alternate names for the annotated object.
  synonyms?: string[];
  // Example questions / usages illustrating the annotated object.
  examples?: string[];
}

/**
 * A vendor-scoped extension block, carried verbatim from the open format's
 * `custom_extensions` (e.g. Apache Ossie's `OSICustomExtension`).
 *
 * `data` is opaque to the IR — a vendor-serialized payload (typically a JSON
 * string) — and is preserved unparsed so nothing is lost and a 1P round-trip
 * stays lossless. Typed views over specific vendors are derived by the
 * consumers that need them, from this same source (e.g. the GOOGLE block).
 */
export interface CustomExtension {
  vendorName: string;
  data: string;
}

/**
 * A semantic model: a graph of entities (nodes) connected by relationships
 * (edges), with model-level metrics defined over them.
 *
 * The IR is primarily semantics. Deployment/target configuration lives in the
 * project manifest (`catalog.yaml`); when the open format carries it inline in a
 * model-level GOOGLE `custom_extensions` block, that block rides along verbatim
 * in `customExtensions` and is interpreted by the consumer that acts on it.
 */
export interface SemanticModel {
  name: string;
  description?: string;
  // AI-first annotations for the model as a whole (instructions, synonyms,
  // examples), kept separate from `description` so an emitter can route them to
  // their own aspects rather than the entry description.
  aiContext?: AiContext;
  entities: Entity[];        // the open format's `datasets`
  relationships: Relationship[];
  metrics: Metric[];
  // Model-level write operations over the ontology -- the write-side counterpart
  // to metrics (which are the read side). Like metrics they are defined over the
  // concepts and their relationships, not bound to a single entity. Optional and
  // absent on models authored before actions existed, so consumers read it as
  // `actions ?? []`. See Action.
  actions?: Action[];
  // Named invariants over the ontology, each stating one condition that must
  // hold for every instance, as a `judgment` in words -- the one body a
  // constraint has, settled by a language model reading the attempted call.
  // Model-level, like metrics and actions. Optional, and
  // absent on models authored before constraints existed, so consumers read it
  // as `constraints ?? []`. See Constraint.
  constraints?: Constraint[];
  // Vendor extension blocks carried verbatim (round-trip fidelity), including the
  // model-level GOOGLE block. A typed deployment-target view is derived by the
  // consumer that acts on it (e.g. the CLI push), not surfaced on the IR yet.
  customExtensions?: CustomExtension[];
}

/**
 * An entity: a node in the semantic graph. Backed by a physical table
 * (`dataSource`), identified by `keys`, and carrying its dimension `fields`.
 */
export interface Entity {
  name: string;
  // A reference to the backing physical source, fully qualified so it identifies
  // that source unambiguously. The IR treats it as an opaque identifier: it fixes
  // neither a syntax (separators, number of parts, quoting) nor a naming scheme
  // -- both are whatever the source system uses. Each producer normalizes it into
  // its own canonical form, and downstream consumers map it to their target's
  // addressing scheme.
  dataSource: string;
  keys: string[];        // grain / primary key
  // Additional uniqueness constraints beyond the primary key; each inner array
  // is one unique column set (maps to the Schema aspect's uniqueConstraints).
  uniqueKeys?: string[][];
  // Names of supertype entities this entity inherits from -- Apache Ossie's
  // `extends` (see ontology/ontology.md), the target of OWL `rdfs:subClassOf`.
  // Inheritance is ENTITY-LEVEL ONLY: only entities carry `extends`;
  // relationships never do (there is no relationship-inheritance field), so OWL
  // `rdfs:subPropertyOf` has no representation here by design.
  //
  // This is the hierarchy AS DECLARED: it records the fact, it does not itself
  // flatten anything. Resolving `extends` into inherited fields (so an emitter
  // sees a self-contained entity) is a separate pass (see resolve_inheritance);
  // the BigQuery leg runs it, so a consumer of the raw IR may still observe
  // `extends` on an entity whose `fields` do NOT yet include the supertype's.
  extends?: string[];
  // Marks a conceptual (abstract) entity with NO physical table: a class used
  // only to group its subtypes (e.g. an abstract `Party` over `Person` and
  // `Organization`). It is never materialized, so it forms no NODE TABLE in the
  // BigQuery graph -- it survives only as a LABEL on its concrete descendants
  // (its fields still flatten down so that shared label's signature is present).
  // An abstract entity therefore has no meaningful `dataSource` or `keys`.
  //
  // This is an EXPLICIT marker, deliberately distinct from the OWL importer's
  // `unbound:<Name>` source placeholder: an unbound source means "should be
  // bound but isn't yet" and must fail the push loudly, whereas `abstract`
  // asserts "intentionally has no table". Overloading one for the other would
  // silently drop an entity someone merely forgot to bind.
  abstract?: boolean;
  description?: string;
  aiContext?: AiContext;
  fields: Field[];       // dimensions / attributes
  customExtensions?: CustomExtension[];
}

/**
 * Dimension metadata on a field, mirroring the open format's `dimension` block
 * (e.g. Apache Ossie's `OSIDimension`). An empty block still marks the field as
 * a dimension, which enables temporal inference from `type` (see isTimeDimension).
 */
export interface Dimension {
  // Explicit temporal-dimension flag. When unset, the effective role is inferred
  // from a temporal `type` (see isTimeDimension).
  isTime?: boolean;
}

/**
 * A field: a dimension / attribute of an entity or relationship.
 *
 * Fields describe the data; aggregates are expressed as model-level `Metric`s,
 * not fields.
 *
 * Expression fidelity: the format may supply an expression in several SQL
 * dialects. We keep at most two forms — a target/canonical `expression` that is
 * valid against the target (GoogleSQL/ANSI), and the original vendor SQL in
 * `importedExpression` (with its `importedDialect`). At least one of the two is
 * set. When only `importedExpression` is present, `expression` awaits a
 * transpile pass (see ./transpile) that fills it from the imported form.
 */
export interface Field {
  name: string;
  expression?: string;             // target/canonical (GoogleSQL-valid) SQL
  importedExpression?: string;     // original vendor SQL, verbatim
  importedDialect?: string;        // dialect of `importedExpression` (e.g. 'SNOWFLAKE')
  // A field with NO physical column under the current binding is UNBOUND:
  // structurally absent, not null. There is no explicit flag -- a field is
  // unbound exactly when it carries no `expression` (and no
  // `importedExpression`); see fieldBinding. A metric, relationship, or action
  // that reads an unbound field is unavailable here rather than reading a null
  // (see the binding-profiles guide). This is the field-level analogue of an
  // entity's `abstract` (a whole class with no table).
  dimension?: Dimension;           // dimension metadata (e.g. temporal role)

  label?: string;                  // human display label (distinct from name/description)
  description?: string;
  type?: DataType;                 // logical datatype (the open format's `datatype`)
  aiContext?: AiContext;
  customExtensions?: CustomExtension[];
}

/**
 * The open format's `datatype` vocabulary, mirroring Apache Ossie's `DataType`:
 * a CLOSED, case-sensitive set of logical types, independent of physical
 * representation. It is optional (omit when unknown); a type outside the
 * vocabulary is expressed as `Opaque` plus a `customExtensions` block, never an
 * invented value. The loader enforces this set at parse time, so a `type` on the
 * IR is always one of these.
 */
export const DATA_TYPES = [
  'String', 'Integer', 'Decimal', 'Float', 'Boolean',
  'Date', 'Time', 'DateTime', 'DateTimeTz', 'Opaque',
] as const;

export type DataType = typeof DATA_TYPES[number];

// The temporal subset of DataType (Date / Time / DateTime / DateTimeTz); a field
// of one of these types is a time dimension by default (see isTimeDimension).
const TEMPORAL_TYPES: ReadonlySet<DataType> = new Set([
  'Date', 'Time', 'DateTime', 'DateTimeTz',
]);

/**
 * A field's effective temporal-dimension role, mirroring the open format's
 * `is_time_dimension()` (e.g. Apache Ossie's `OSIField`): a field must carry
 * `dimension` metadata to be a dimension at all; within it an explicit `isTime`
 * takes precedence, otherwise the role defaults from a temporal `type`.
 */
export function isTimeDimension(field: Field): boolean {
  if (!field.dimension) return false;
  if (field.dimension.isTime !== undefined) return field.dimension.isTime;
  return field.type !== undefined && TEMPORAL_TYPES.has(field.type);
}

// The physical column (or SQL) a field binds to under the current binding, or
// undefined when the field is unbound (structurally absent -- no column). A
// field's target/canonical `expression` wins; a field awaiting transpilation
// falls back to its imported vendor expression, which still names a real column,
// so it is bound rather than unbound. A field with neither is unbound (no
// column at all). This is the single source of truth for "is this field bound";
// availability pruning and the BigQuery generator both consult it so they never
// disagree.
export function fieldBinding(field: Field): string | undefined {
  return field.expression ?? field.importedExpression;
}


/**
 * A relationship: a directed foreign-key edge in the semantic graph, from
 * `source` to `destination`. The join pairs the endpoints' columns positionally
 * (`source.columns[i] = destination.columns[i]`): the source's foreign-key
 * columns referencing the destination's key columns.
 */
export interface Relationship {
  name: string;
  source: RelationshipEnd;
  destination: RelationshipEnd;
  // When present, this edge is a many-to-many backed by a junction table rather
  // than a direct foreign key on the source entity. See Association.
  association?: Association;
  description?: string;
  aiContext?: AiContext;
  customExtensions?: CustomExtension[];
}

/**
 * One endpoint of a relationship: the entity it attaches to and the columns on
 * that entity's own table that participate in the join.
 */
export interface RelationshipEnd {
  entity: string;        // name-reference into SemanticModel.entities
  columns: string[];     // join columns on this endpoint's table
}

/**
 * An association (junction) table backing a many-to-many relationship.
 *
 * A many-to-many link cannot be a foreign key: an FK column holds a single value
 * and so references at most one row (a to-one direction), which cannot encode a
 * pairing where each side maps to many of the other. The pairs instead live in a
 * separate junction table, one row per (source, destination) -- e.g. an
 * `enrollment` row per (student, course).
 *
 * Unlike a direct foreign key -- which the open format expresses and the loader
 * produces -- a junction edge is backed by its OWN table (`dataSource`) with its
 * OWN key (`keys`) and may carry edge `fields` (properties of the association
 * itself, e.g. an enrollment's grade). Each side names the columns ON THE
 * JUNCTION TABLE that reference the corresponding endpoint entity's declared
 * `keys`. The open format has no association-table syntax yet, so this is
 * produced by hand-built IR (or a future format extension), not the loader.
 */
export interface Association {
  dataSource: string;            // the junction table backing the edge
  keys: string[];                // the edge's own key on the junction table
  sourceColumns: string[];       // junction columns referencing the source entity's key
  destinationColumns: string[];  // junction columns referencing the destination entity's key
  fields?: Field[];              // edge properties (junction non-key columns)
}

/**
 * A metric: a model-level, named aggregate.
 *
 * Because it lives on the model rather than a single entity, a metric may span
 * multiple entities — its `expression` can reference fields across the graph,
 * joined via relationships. See `entity` for the single attach point and how
 * it's derived.
 *
 * Expression fidelity mirrors `Field`: a target/canonical `expression` and/or
 * the original vendor `importedExpression` (+ `importedDialect`).
 */
export interface Metric {
  name: string;
  expression?: string;   // target/canonical aggregate; may reference entity-qualified fields
  importedExpression?: string; // original vendor SQL, verbatim
  importedDialect?: string;    // dialect of `importedExpression`
  // The single entity this metric attaches to -- the node it hangs off -- when
  // its `expression` references exactly one. NOT part of the open format (Ossie's
  // Metric has no such field): the loader DERIVES it by scanning the expression
  // for known `entity.column` qualifiers (see referencedEntityNames). Omitted
  // when the expression names no known entity (e.g. `COUNT(*)`; the loader warns)
  // or references several -- a cross-entity metric whose join path consumers
  // resolve from the model's relationships (the qualifiers stay inline in the
  // expression).
  entity?: string;
  description?: string;
  type?: DataType;       // logical datatype of the result (the open format's `datatype`)
  aiContext?: AiContext;
  customExtensions?: CustomExtension[];
}

/**
 * An action: a model-level, named write operation over the ontology -- the
 * write-side counterpart to a metric's read. Like a metric it lives on the
 * model (not a single entity) and may span several entities via its typed
 * `parameters`.
 *
 * The model contributes only what the ontology can say that a plain tool schema
 * cannot: typed parameters (an entity-typed one is an object reference) and the
 * constraints that gate the call. The mechanics of running it are delegated to
 * an `executor` (e.g. an MCP tool in Agent Registry); `description` is
 * informational and does not affect runtime.
 */
export interface Action {
  name: string;
  description?: string;
  // How the action is executed: exactly one executor kind, normalized by the
  // loader from the open format's single-key object to this discriminated form.
  //
  // This is the action's PHYSICAL BINDING, and the one part of an action that
  // is not a logical declaration. The same operation is performed differently
  // in different stores -- DML where the data sits in a relational database, a
  // call to whoever owns the data where it does not -- so a binding profile may
  // supply or replace it, exactly as it supplies an entity's `source`.
  //
  // Absent when no binding supplies one. That makes the action unavailable,
  // not invalid: an action with no executor still declares what it does, what
  // gates it, and what it changes, which is the whole of what a reader needs.
  executor?: Executor;
  // Inputs, each typed by the ontology: an entity type is an object reference,
  // a scalar type an ordinary value. See ActionParameter.
  parameters: ActionParameter[];
  // The constraints that gate this action, by name. This list is what gives a
  // constraint effect over the action. A constraint no action names is a
  // catalogued rule that no call consults, so adding one to a model cannot
  // silently start refusing calls that succeeded before it was published.
  //
  // Both kinds of rule belong here. One reading the action's parameters has no
  // other moment to run. One over stored data, guarded, says the call must not
  // proceed from a state that is already broken -- which is less than the rule
  // itself says, because nothing binds a check to the state a write produces.
  guards?: string[];
  // What the call changes: its blast radius, one entry per concept touched.
  // Declared rather than derived, because the executor is opaque -- nothing
  // reading the model can see what an MCP tool writes. See AffectedConcept.
  affects?: AffectedConcept[];
  aiContext?: AiContext;
  customExtensions?: CustomExtension[];
}

/**
 * One concept an action changes, and how.
 *
 * `concept` is the authored name of an entity or a relationship, kept verbatim
 * for a lossless round-trip. Which of the two it is, is deliberately NOT
 * recorded: it is a fact about the model, it changes nothing about what the
 * entry means, and the same three operations apply either way. Whoever needs
 * the distinction -- validate does, to know which fields the concept has --
 * resolves it against the model, so there is one place it can be wrong instead
 * of two. The loader warns about a name that resolves to neither.
 *
 * `operation` and `fields` are optional, and their absence means "unspecified"
 * rather than "nothing". The open format accepts a bare name as shorthand for
 * an entry with neither -- `affects: [Order]` is the coarse blast radius the
 * proposal describes -- so a model can start there and add precision only
 * where a rule needs it.
 */
export interface AffectedConcept {
  concept: string;  // entity or relationship name, as authored
  operation?: ConceptOperation;
  // The fields the operation touches, when it touches only some of them. Each
  // must be a field of `concept`. Meaningless for a `delete`, which takes the
  // whole instance, which is why validate rejects that pairing.
  fields?: string[];
}

/**
 * What an action does to a concept it affects.
 *
 * One vocabulary covers entities and relationships alike, because both admit
 * the same three acts. An edge is not only added and removed: a many-to-many
 * relationship is backed by a junction table with fields of its own (see
 * Association), so modifying an enrollment's grade is as ordinary as modifying
 * an order's total. Splitting the vocabulary by kind would make that change
 * inexpressible and would buy a policy predicate nothing.
 */
export const CONCEPT_OPERATIONS = ['create', 'modify', 'delete'] as const;
export type ConceptOperation = typeof CONCEPT_OPERATIONS[number];

/**
 * One input to an action, typed by the ontology.
 *
 * `type` is the authored type name, kept verbatim for a lossless round-trip.
 * `isEntityRef` is DERIVED by the loader: true when `type` resolves to a known
 * entity (the parameter is an object reference to that entity), false when it
 * is a scalar `DataType`. A type that resolves to neither leaves `isEntityRef`
 * undefined and the loader warns.
 */
export interface ActionParameter {
  name: string;
  type: string;           // entity name (object reference) or a scalar DataType
  description?: string;
  required?: boolean;
  default?: unknown;
  isEntityRef?: boolean;  // derived: true when `type` names a known entity
}

/**
 * The mechanics of how an action is executed: exactly one kind, tagged so
 * consumers can switch on it. The open format expresses it as an object with a
 * single kind key (`mcp` / `rest` / `grpc`); the loader normalizes that to this
 * discriminated union. Other kinds (SQL DML, CLI, ...) can be added later.
 */
export type Executor =
  | { kind: 'mcp'; mcp: McpExecutor }
  | { kind: 'rest'; rest: RestExecutor }
  | { kind: 'grpc'; grpc: GrpcExecutor }
  | { kind: 'sql'; sql: SqlExecutor };

/**
 * A SQL executor: the write itself, declared in the model as an ordered list of
 * DML statements.
 *
 * The other three executor kinds name a system that performs the write, so what
 * the write does is opaque to the model. This one contains it, which buys two
 * things the opaque kinds cannot offer.
 *
 *   - The blast radius is checkable. `affects` can be read against the
 *     statements rather than taken on trust.
 *   - A guard becomes a real gate. An MCP, REST or gRPC call commits inside a
 *     system the runtime does not control, so a write it performed could not be
 *     rolled back if the rest of the action failed; a statement run in the
 *     runtime's own transaction can be. Guards settle before that transaction
 *     opens (see run_action.ts), so a refusal leaves the store untouched and no
 *     check ever observes the write it gates.
 *
 * The narrowness is the safety argument, and validate.ts enforces it. A
 * statement is a single INSERT, UPDATE or DELETE. Every `@name` it binds names
 * a parameter the action declares, so an argument reaches the store as a bound
 * value and never as SQL. There is no control flow, no statement composed at
 * call time, and no way for a caller to supply a statement of its own: an
 * action whose body arrives with the call declares nothing, and a gate cannot
 * check what was never declared.
 *
 * A row the statement inserts needs a primary key, and the statement is what
 * decides where it comes from: a UUID function the store offers, a value the
 * caller passes as an ordinary parameter, or the key column left out where it
 * has a default. The runtime generates nothing on its behalf. A key that comes
 * in as a parameter is one the caller chooses, and the check in validate.ts
 * reads only a statement's first word, so an upsert passes and overwrites the
 * row that key names.
 */
export interface SqlExecutor {
  // The statements, run in order inside the action's transaction. Each is a
  // single DML statement; parameters are referenced as `@name`.
  statements: string[];
}

// The verbs a SQL executor's statement may begin with. A statement is one write,
// so there is no SELECT here and no DDL: a statement that reads is a query and
// belongs in a metric, and a statement that reshapes the schema is not an action.
export const SQL_EXECUTOR_VERBS = ['INSERT', 'UPDATE', 'DELETE'] as const;

/**
 * An MCP executor: references a tool already registered in Agent Registry, by
 * the MCP server's resource name plus the tool's in-server selector. Agent
 * Registry is the canonical source consumed at runtime (e.g. by an agent).
 */
export interface McpExecutor {
  server: string;   // e.g. //agentregistry.googleapis.com/.../mcpServers/commerce
  tool: string;     // the tool's name within that server
}

/** A REST executor: an HTTP endpoint and method. */
export interface RestExecutor {
  endpoint: string;
  method: string;
}

/** A gRPC executor: a fully-qualified service and method. */
export interface GrpcExecutor {
  service: string;
  method: string;
}

/**
 * What a violated constraint does to the write that tripped it.
 *
 *   - `reject`   the write is refused. Nobody is allowed to approve it, which
 *                is what makes the rule an invariant rather than a policy.
 *   - `escalate` the write is held and a person decides. The rule is a business
 *                threshold, so somebody is allowed to say yes.
 *   - `warn`     the write proceeds and the violation is reported.
 *
 * An engine reading the catalog needs this in order to route. Without it every
 * rule publishes with the same shape, and a $30 credit that needs a supervisor
 * is indistinguishable from one that is simply forbidden.
 *
 * This is a disposition, not a magnitude, and the two are deliberately separate
 * keys. `escalate` is not "between" reject and warn on a scale of badness: it is
 * a different control flow, and what it really states is that an approver
 * exists. Two rules can be equally grave -- both guarding a million-dollar write
 * -- and differ only in whether anyone in the organization is entitled to say
 * yes. See CONSTRAINT_SEVERITIES for the magnitude.
 *
 * `escalate` names that an approver exists. It does not name who: an approver
 * role is not modeled yet.
 *
 * The consequence is a field rather than something a `judgment` states in its
 * own prose, because three things need it without running a judge. An
 * unrunnable judge -- none configured, a failed call, a timeout -- still has to
 * route the breach it could not evaluate. A search for the rules that can stop
 * a write cannot read prose. And a policy DSL states its effect in the rule
 * head, so a rule whose consequence is only implied by its wording cannot be
 * lowered into OPA or Cedar.
 *
 * A judgment may declare any of the three, `reject` included. What settles a
 * judgment can decide two identical proposals differently, and `reject` leaves
 * no appeal, so that pairing is the riskiest thing this model can express. It
 * is still a bet an organization is entitled to place, and refusing to
 * represent it would move the policy out of the catalog rather than prevent it.
 * It is made auditable instead: `evaluation` publishes `judged` beside the
 * word, so "unappealable rules settled by a model" is one query. `onViolation`
 * is required on a judgment rather than defaulted, because a forgotten word
 * would produce exactly that pairing silently.
 *
 * A constraint's word is the consequence of the one condition it states. A
 * policy whose conditions carry different consequences is written as several
 * constraints, which `guards` on an action lists together; the strictest
 * consequence among the violated ones is what the action does. See
 * docs/semantic-model/actions.md for a worked policy.
 *
 * STATUS: the declared word is published, read back, and routed on for the
 * rules something settles. A judgment is settled where an action names it in
 * `guards`, and `warn` reports while `reject` and `escalate` stop the call;
 * `escalate` says so in the refusal, because nothing here has an approver to
 * route to. An expression is still text nothing computes, so its word decides
 * nothing yet.
 */
export const VIOLATION_EFFECTS = ['reject', 'escalate', 'warn'] as const;

export type ViolationEffect = (typeof VIOLATION_EFFECTS)[number];

/**
 * How grave a violation of a constraint is, independent of what the engine does
 * about it.
 *
 * Ranking and reporting want this: which of forty violations in a batch to show
 * a human first, which to page on. Enforcement does not -- that is
 * `onViolation`, and the split is the point. A `low` rule may still be an
 * absolute `reject`, and a `critical` one may be a `warn` because the
 * organization is not ready to block on it yet.
 *
 * The scale is the ordinary four-point one, and it avoids `warning` on purpose:
 * a severity called `warning` sitting beside an effect called `warn` would read
 * as the same statement made twice.
 *
 * STATUS: authored, published and read back. Nothing ranks or routes on it yet.
 */
export const CONSTRAINT_SEVERITIES =
    ['critical', 'high', 'medium', 'low'] as const;

export type ConstraintSeverity = (typeof CONSTRAINT_SEVERITIES)[number];

/**
 * A constraint: a model-level, named invariant over the ontology, stated in
 * words and settled by a language model reading the call that would break it.
 *
 * A `judgment` is the rule as a sentence: *the credit memo must name a specific
 * service failure*, *the order must be within the customer's standing limit*.
 * It is the one body a constraint has, so settling any rule is a model call;
 * `expression` is a reserved key the loader refuses. See "what a judgment
 * costs" in docs/semantic-model/actions.md.
 *
 * A judgment states ONE condition, because the consequence is carried by
 * `onViolation` and one word cannot route two branches. A policy whose branches
 * end differently -- a missing approval is held for a person, a disguised
 * transaction is refused -- is written as one constraint per branch, and
 * `guards` on the action lists them together.
 *
 * What the catalog offers a judged rule is identity and governance, never
 * determinism: one name, one owner, one version, one declared consequence, and
 * the same text for every caller instead of prose re-improvised per call. A
 * language model can still decide two identical proposals differently, and no
 * schema changes that. `onViolation` is required so that the consequence of
 * that non-determinism is always stated rather than inherited.
 *
 * STATUS: authored, validated, published and enforced. kcmd carries a
 * constraint to Knowledge Catalog, where an agent can read the rules a model
 * requires. Where an action names a constraint in `guards`, the judgment is
 * settled before the transaction opens, which is why it reads the attempted
 * call and never the state the write produced: a rule about the RESULT of a
 * write is not something this body states. A caller that supplies no judge gets
 * nothing settled -- the action is refused rather than run past the rule.
 *
 * `description` is the error text a violation would surface, so write it to
 * steer an agent's next move -- "reduce the order quantity or choose another
 * customer" -- rather than to label the rule.
 */
export interface Constraint {
  name: string;
  // The rule in words. Write field names model-qualified (`LineItem.memo`
  // rather than "the memo"): validate resolves every `Entity.field` token in
  // the text, so the reference is checked, and it lives in the sentence that
  // uses it rather than in a second list that drifts from the prose beside it.
  // States one condition, in the form of what must be true rather than what to
  // do, and says what does not satisfy it: a policy with several conditions
  // goes in several constraints, regrouped by `guards` on the action. The
  // consequence goes in `onViolation`, not the prose. Optional on the type and
  // required in fact -- validate reports a constraint that states none, so the
  // author gets a message naming the constraint rather than a schema error
  // naming a position in the document.
  judgment?: string;
  description?: string;  // human-readable summary; also the violation error
  // What a violation of this constraint does to the write. Required, any of the
  // three words, because inheriting the harshest one by silence is not a thing
  // to do to a rule a model settles. See VIOLATION_EFFECTS.
  onViolation?: ViolationEffect;
  // How grave a violation is, for ranking and reporting. Orthogonal to
  // `onViolation`, and carries no default -- an author who did not say has not
  // said, and nothing reads it yet. See CONSTRAINT_SEVERITIES.
  severity?: ConstraintSeverity;
  aiContext?: AiContext;
  // No `customExtensions`. Every other IR object has one because vanilla Ossie
  // accepts `custom_extensions` on it. A constraint is unreachable that way:
  // `constraints` is an extended-profile-only key, and the extended profile
  // rejects `custom_extensions` outright (ceField in loader.ts), so no document
  // can carry both. Should vanilla Ossie ever gain constraints, add the field
  // back with `...ce` on the schema.
}
