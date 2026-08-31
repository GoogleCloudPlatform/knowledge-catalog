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
  // Marks a field declared logically but with NO physical column under the
  // current binding: structurally absent, not null. A metric, relationship, or
  // action that reads it is unavailable here rather than reading a null (see
  // the binding-profiles guide). An unbound field carries no `expression`.
  //
  // This is the field-level analogue of an entity's `abstract` (a whole class
  // with no table) and, like the OWL importer's `unbound:` source placeholder,
  // means "should be bound by some binding, and reading it where it is not is an
  // error" -- distinct from a bound field whose value merely happens to be null.
  unbound?: boolean;
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
// so it is bound rather than unbound. `unbound: true` means no column at all.
// This is the single source of truth for "is this field bound"; availability
// pruning and the BigQuery generator both consult it so they never disagree.
export function fieldBinding(field: Field): string | undefined {
  if (field.unbound) return undefined;
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
 * cannot -- typed parameters (an entity-typed one is an object reference). The
 * mechanics of running it are delegated to an `executor` (e.g. an MCP tool in
 * Agent Registry); `description` is informational and does not affect runtime.
 */
export interface Action {
  name: string;
  description?: string;
  // How the action is executed. Exactly one executor kind (mcp / rest / grpc);
  // the loader normalizes the open format's single-key executor object to this
  // discriminated form.
  executor: Executor;
  // Inputs, each typed by the ontology: an entity type is an object reference,
  // a scalar type an ordinary value. See ActionParameter.
  parameters: ActionParameter[];
  aiContext?: AiContext;
  customExtensions?: CustomExtension[];
}

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
  | { kind: 'grpc'; grpc: GrpcExecutor };

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
