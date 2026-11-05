# What push and pull preserve

Your model document is the source of truth. Pushing it — to Knowledge Catalog
and to a property graph in BigQuery or Spanner — and pulling it back are each
**lossy in specific ways**. The catalog keeps metadata, the graph keeps what it
can query, and `pull` can only return what the catalog was given. This page is
the one authoritative map of what survives each direction. Keep your authored
document.

Which backend a push deploys to — BigQuery or Spanner — is set by each entry's
`target` in `deployments`, and which binding feeds it is set by that entry's
`profile`; neither is a backend flag on the command line (see
[Reference → push](reference.md#push) for `--deployment` and
`--no-deployment`). Each destination has its own section below, starting with
[To Knowledge Catalog](#to-knowledge-catalog).

## The round-trip matrix

Rows are what you authored; columns are its fate in each direction. `✓` = comes
back as authored; `—` = not present in that destination. Footnotes carry the
nuances that don't fit a cell. BigQuery and Spanner each get a column; they
agree on every structural row and differ only where a Spanner target has no
`MEASURE` and no `OPTIONS` metadata, and in which SQL text a field reads — see
[To Spanner](#to-spanner).

| Authored element                                               | → Knowledge Catalog             | Recovered by `pull`                            | → BigQuery                                                           | → Spanner                                                            |
|----------------------------------------------------------------|---------------------------------|------------------------------------------------|----------------------------------------------------------------------|----------------------------------------------------------------------|
| Entity (name, `source`)                                        | `semantic-entity` entry¹⁰       | ✓                                              | `NODE TABLE`                                                         | `NODE TABLE`                                                         |
| Field                                                          | `schema` aspect column          | ✓ (type collapses²)                            | column on the node table¹                                            | column on the node table¹                                            |
| Field `label`                                                  | `schema` per-field annotation   | ✓                                              | into `OPTIONS(description)`                                          | — dropped                                                            |
| Field expression (canonical SQL)                               | `sql-expressions` aspect³       | ✓³                                             | builds the DDL                                                       | builds the DDL                                                       |
| Field dimension role (`is_time`)                               | `schema` per-field `semantic`³  | ✓³                                             | noted in `OPTIONS(description)`                                      | — dropped                                                            |
| Primary key                                                    | `schema.primaryKey`             | ✓                                              | `KEY(...)` on the node table                                         | `KEY(...)` on the node table                                         |
| Unique keys                                                    | `schema.uniqueConstraints`      | ✓                                              | the first is `KEY(...)` when there is no primary key; else dropped   | the first is `KEY(...)` when there is no primary key; else dropped   |
| Metric                                                         | `semantic-metric` entry         | name, entity, description, instructions, type⁵ | `MEASURE`⁴                                                           | — dropped (no `MEASURE`)                                             |
| Relationship (1:1 / 1:N)                                       | `schema-join` link¹⁵            | ✓ (name normalized⁶)                           | `EDGE TABLE`                                                         | `EDGE TABLE`                                                         |
| Relationship (M:N / `association`)                             | — not stored                    | —                                              | `EDGE TABLE` (via junction table)                                    | `EDGE TABLE` (via junction table)                                    |
| Entity `extends`                                               | — not modelled                  | —                                              | `LABEL` clauses + flattened fields                                   | `LABEL` clauses + flattened fields                                   |
| Action                                                         | `semantic-action` entry¹²       | ✓¹²                                            | — not deployed¹²                                                     | — not deployed¹²                                                     |
| Constraint                                                     | `semantic-constraint` entry¹³   | ✓¹³                                            | — not deployed¹³                                                     | — not deployed¹³                                                     |
| `description` (entity / metric / field / relationship)         | entry description / aspect      | ✓                                              | `OPTIONS(description)`                                               | — dropped                                                            |
| `ai_context.synonyms`                                          | — not stored                    | —                                              | `OPTIONS(synonyms=[...])`                                            | — dropped                                                            |
| `ai_context.instructions`                                      | `guidelines` aspect⁷            | ✓⁷                                             | into `OPTIONS(description)`                                          | — dropped                                                            |
| `ai_context.examples`                                          | — not stored                    | —                                              | into `OPTIONS(description)` (`Examples:` line)                       | — dropped                                                            |
| Model-level `description` / `instructions`                     | on the model entry              | ✓⁸                                             | — dropped⁸                                                           | — dropped⁸                                                           |
| Model-level `ai_context.synonyms` / `examples`                 | — not stored                    | —                                              | — dropped                                                            | — dropped                                                            |
| `deployments` (`name`, `target`, `profile`)                    | recorded on the model entry     | ✓                                              | names the graph                                                      | names the graph                                                      |
| Binding profile (`<model>.profile.<name>.yaml`)                | on the model's entries¹⁴        | ✓¹⁴                                            | one graph per BigQuery deployment                                    | one graph per Spanner deployment                                     |
| Vendor-dialect `expression` variant (non-canonical `dialects[]` entry)¹¹ | — not stored          | —                                              | — not used; a field or metric with only vendor text is left out     | — not used; a field with only vendor text is left out               |
| `custom_extensions` from a vendor other than GOOGLE            | — not stored                    | —⁹                                             | — not in graph                                                       | — not in graph                                                       |

1. **Field type source.** The graph uses the source column's own type; a
   field's authored `datatype` is not carried.
2. **Field type collapse.** Field types round-trip except one collapse:
   `String` → un-typed. A field with no type and a `String` field both store
   `dataType STRING` (with `metadataType` `OTHER` and `STRING` respectively),
   and `pull` writes no `datatype` for either, so only `String` is lost.
3. **Expressions and dimension role.** The second-generation types (the
   default) store each field's expression in its entity's `sql-expressions`
   aspect, and its dimension role and `is_time` in the `schema` aspect, and
   `pull` rebuilds both from there. The first-generation types
   (`KC_V2_ASPECTS=0`) omit the per-field `semantics` block, so a model pushed
   with them comes back with no field expression and no dimension marker.
4. **Metric shape.** A metric must resolve to exactly one entity, or the push
   is rejected. It must also reduce to one supported aggregate over one
   operand: `SUM`, `AVG`, `COUNT`, `MIN` or `MAX`. Otherwise the push is
   rejected.
5. **Metric type.** When rebuilding from v1 catalog metadata, a metric's
   data type round-trips only for a concrete type (e.g. `Decimal`) — an
   untyped, `String`, or `Opaque` metric comes back un-typed.
6. **Relationship name.** Relationship names come back lowercased
   (`Places_Order` → `places_order`) — the catalog stores the name only in the
   link id. See [Writer-side follow-up](#writer-side-follow-up).
7. **Guidelines aspect.** The `guidelines` aspect exists only for the model,
   entities, and metrics — not fields or relationships, so field- and
   relationship-level `ai_context.instructions` has no Knowledge Catalog home (a
   relationship's instructions still reach BigQuery, folded into the edge's
   `OPTIONS(description)`).
8. **Model-level metadata.** Neither graph has a home for statement-level
   metadata — BigQuery silently drops graph-statement `OPTIONS`, and Spanner
   carries no `OPTIONS` at all — so the model's `description` and
   `ai_context.instructions` are carried into Knowledge Catalog instead.
9. **Other custom extensions.** A `custom_extensions` block from a vendor other
   than GOOGLE is inert on push and has no catalog entry or aspect of its own.
   The OWL importer emits none:
   it is import-only (see [Importing an OWL ontology](owl-import.md)).
10. **Logical (unbound) model.** A model with no bindings still publishes to
    Knowledge Catalog: each entity's `source` is recorded empty (`resources: []`)
    because there is no table behind it, and a relationship that carries no join
    columns is skipped with a warning.
11. **Vendor-dialect fallback.** What you author is the `expression.dialects[]`
    list using one of the supported SQL dialects (see
    [Model spec §2.5](model_spec.md#25-expressions)).
    `importedExpression` / `importedDialect` are not
    authored keys — the loader *derives* them from a non-canonical dialect entry
    (for example the `SNOWFLAKE` or `DATABRICKS` form a metric was imported
    from). `kcmd import
    --transpile` adds a `BIGQUERY` dialect entry to a model file's field or
    metric, translated from a vendor-only expression or from an `ANSI_SQL`
    expression that double-quotes column names. It does the same in each
    profile the import writes, when all of that profile's tables are in
    BigQuery or BigLake. Without the translation, kcmd warns about
    either kind of text on a BigQuery table. Spanner, MySQL and Databricks
    also read a double-quoted name as text, so kcmd warns about that kind on
    their tables, apart from a Spanner table in a PostgreSQL-dialect database,
    which push and `kcmd profiles` judge as `POSTGRES`.
    On a table in another database, it warns about a field or metric with no
    text that table runs. Push rejects such a field in the model file with an
    error in place of the warning. `kcmd import` gives push's message in place
    of the warning on an AlloyDB table. When a profile binds that
    table, push rejects the field or metric instead. `kcmd import` does not look
    up a Cloud SQL or third-party table's dialect or a Spanner database's.
    `kcmd skills-generate` and `kcmd profiles --print-store` do not look up a
    third-party table's dialect, and they read a Spanner table as `SPANNER`.
    Import reads a Cloud SQL table whose name has no schema as MySQL. It reads
    a table in the database a Spanner deployment targets as `SPANNER`, since
    push refuses that deployment on a PostgreSQL-dialect database. On any
    other table whose dialect a command has not looked up, kcmd warns only about
    a field or metric with no text in any dialect the table's name allows.
    Push rejects such a field, so `kcmd import --input first-party` gives an
    error for it in the model file and in a profile. A
    BigQuery
    graph reads a field's or metric's `BIGQUERY` entry, else its `ANSI_SQL` one. It never emits the
    vendor text. A field with none of these is left out of its node table with
    a warning, though push rejects such a field in the model file first. A
    metric with none, or one that aggregates such a field, is
    skipped with a warning. A Spanner graph reads a field's `SPANNER` entry,
    else its `ANSI_SQL` one, and leaves out a field with neither. See
    [Model spec §2.5](model_spec.md#25-expressions).
12. **Actions.** An action reaches Knowledge Catalog only, as one
    `semantic-action` entry under the model entry, and `pull` reads it back from
    that entry. Every other push target deploys nothing for it and warns once.
    Its `guards` are stored as constraint names and round-trip verbatim. A name
    whose constraint is absent from a pull is kept rather than dropped, so a
    partial pull never silently rewrites the author's model; the pull warns
    about the name it kept, and a push rejects the model until the constraint
    is back. A name the aspect repeats is the one exception, dropped to its
    single occurrence because the loader rejects a repeat and the document has
    to stay loadable. Its `affects` round-trips the same way, with the same
    exception for a repeated concept-and-operation pair. See
    [Modeling write operations](actions.md).
13. **Constraints.** A constraint reaches Knowledge Catalog only, as one
    `semantic-constraint` entry under the model entry, and `pull` reads it back.
    Every other push target deploys nothing for it and warns once. Publishing is
    all that push does with a constraint; what settles one is a run, and the
    runtime an application embeds is what puts each guard to a judge before the
    write.
14. **Binding profiles and deployments.** A model may define several physical
    realizations in sibling `<model>.profile.<name>.yaml` files and reference
    them from `deployments` (see [Binding profiles](profiles.md) and
    [Reference → push](reference.md#push)); two deployments claiming the same
    target are rejected before anything deploys. With the second-generation
    types (the default), push records each named profile and what it binds on
    the model's entries, and `pull` rebuilds one profile file per named
    profile from them. The catalog stores no profile's actions, so a pulled
    profile file keeps the actions the local one binds. The first-generation
    types (`KC_V2_ASPECTS=0`) hold no profile, so a pull with them writes no
    profile file and keeps the local ones.
15. **Relationships with no link.** Knowledge Catalog keeps one `schema-join`
    link between two entries, so when several relationships join the same two
    entities, push links the first one it can publish and skips the rest with
    a warning. The catalog metadata holds no link for a skipped relationship.

## To Knowledge Catalog

The catalog holds the model's metadata. Every resource type it uses is a
built-in system type under `dataplex-types/global`, apart from the custom
`semantic-action` and `semantic-constraint` pairs that `kcmd init`
provisions. A push references those types and never creates them (see
[Reference → What gets created in Knowledge Catalog](reference.md#what-gets-created-in-knowledge-catalog)).

Every push publishes the model file as written to Knowledge Catalog: every
entity, metric, and relationship the document declares, apart from the
relationships in footnote 15. A `pull` rebuilds the model and profile files
from that metadata alone, so comments, key order and formatting are not kept.

A logical model still produces complete entries. Each entity's `source` is
recorded empty (`resources: []`) because there is no table behind it, and a
relationship that carries no join columns is skipped with a warning.

**Model file and sibling profile files.** A model may define several physical
realizations — an analytical binding onto BigQuery (`<model>.profile.analytical.yaml`)
and an operational one onto Spanner (`<model>.profile.operational.yaml`), say —
and list both in `deployments`. Push records each named profile in the catalog
metadata, and `pull` rebuilds the profile files from it (footnote 14; see
[Reference → push](reference.md#push)).

In the v1 catalog aspects (`KC_V2_ASPECTS=0`), SQL expressions are omitted
because the published v1 system-type templates do not carry a per-field
`semantics` block or a `semantic-metric.expression` field (with the
second-generation types, the default, expressions are stored in the
`sql-expressions` aspect). The v1 catalog aspects also do not store
`ai_context.synonyms` / `examples`, field-level `ai_context` (only model,
entity, and metric `instructions` have a home, in the `guidelines` aspect), or
the original vendor SQL (`importedExpression` — for example the `SNOWFLAKE` or
`DATABRICKS` form a metric was imported from). A pull of a model pushed with
them cannot return any of those; they survive only in your authored document.

**Actions** follow the same one-entry-per-element rule as everything else: each
becomes a `semantic-action` entry under the model entry, carrying its executor,
typed parameters, `guards`, and `affects` in a `semantic-action` aspect. They
round-trip losslessly through `pull` (name, description, executor, typed
parameters, `guards`, `affects`, and `instructions`). A parameter projected
from a field round-trips as the projection it was authored as: the aspect
stores `concept` and `field` alongside the resolved scalar `type`, and a pull
writes the projection back out without the type, so re-loading resolves it from
the same field and arrives at the same parameter. Two things about a projection
do not survive the trip. Its `label` and `ai_context` are dropped — the aspect
has nowhere to put them, so a pull recovers the parameter's `description` and
not those two. And the wording a pull does recover comes back as the
parameter's own: the loader resolves an inherited `description` into the
parameter when the model loads, and nothing downstream can tell that apart from
one the author typed, so a pulled document states it where the original left it
to the field. Re-loading gives the same parameter, but the field and the
parameter now each hold a copy, and changing the field no longer moves it.
A projection whose field is not in the pulled document — pruning drops an
entity no binding reaches — comes back as a declared parameter carrying the
resolved `type` instead, since emitting a `concept`/`field` pair that resolves
to nothing would write a document that will not load. A `sql` executor
round-trips its `statements` with the rest: they are the
write, not a note about it, so a catalog that dropped them would describe an
action nobody could re-deploy. The entry type is custom, so `kcmd init` creates
it; a model that declares no action never needs it.

What an action affects round-trips as a fact, not as the text it was authored
in. The two authored shapes — the bare name and the record — are one shape in
the model, so a record carrying nothing but a concept (`- concept: Account`)
comes back as the bare `Account`, which says the same thing. Everything after
that first pass is byte-for-byte stable.

`affects` stores only what the author wrote, which is why it survives a partial
pull intact. Whether a `concept` is an entity or an edge is not recorded, so
nothing about it has to be re-resolved — and nothing can go stale. That matters
most for a many-to-many relationship, which never reaches the catalog at all: a
pull recovers relationships from the schema-join entry links, which carry the
foreign-key edges only, so a concept naming an M:N edge would look unresolvable
on a model that is perfectly well-formed. It comes back untouched instead.

**Constraints** publish the same way: each becomes a `semantic-constraint` entry
under the model entry, with the rule and any `instructions` in a
`semantic-constraint` aspect and the `description` as the entry's own summary.
Name, description, `on_violation`, `severity`, instructions, and whichever body
states the rule — `expression` or `judgment` — round-trip losslessly through
`pull`. A constraint that declares neither routing word comes back without them
rather than with a default filled in. The aspect also carries a derived
`evaluation` field, `deterministic` or `judged`, which a pull recomputes from
the body rather than reading, so it can never come back disagreeing with the
rule beside it; it is not written into the authored document, because a derived
value in an authored file is a value that can go stale. An entry that states
both bodies, or neither, is skipped with a warning rather than pulled into a
model that would then fail its own push. That entry type is custom too, and a
model that declares no constraint never needs it.

## To BigQuery

Push preserves both the queryable structure and the descriptive metadata attached
to it. The structure becomes the node tables, edge tables, and measures; the
descriptive metadata is written into each element's `OPTIONS(...)` in the graph
(visible with `--print`).

BigQuery's graph `OPTIONS` give an element a `description` string and a `synonyms`
array. `synonyms` is the only part with a dedicated option, so it carries across
structurally, as its own array. The rest — `description`, `instructions`,
`examples`, and a field's `label` — share the single `description` string, so
they are combined into it (examples as an `Examples: …` line). Their content is
preserved; their separate structure is not.

The model's own statement-level metadata has nowhere to go: BigQuery silently
drops graph-statement `OPTIONS`, so the model's `description` / `ai_context` are
not in the graph — the `description` and `ai_context.instructions` are carried
into Knowledge Catalog instead. Of an entity's keys only one is emitted: its
primary key, else its first unique key. The imported vendor SQL is never
emitted. `kcmd import --transpile` adds a `BIGQUERY` entry to a model file's
field or metric whose expression is vendor-only or an `ANSI_SQL` expression
that double-quotes column names. It does the same in each profile the import
writes, when all of that profile's tables are in BigQuery or BigLake.
The graph builds each field and metric from its `BIGQUERY` entry, else its
`ANSI_SQL` one. A field with none of these is left out of its node table with a warning,
though push rejects such a field in the model file first. A
metric with none, or one that aggregates such a field, is skipped with a
warning.

## To Spanner

A Spanner target keeps the queryable **structure** and drops the descriptive
metadata. The node tables, edge tables, and labels (including the `extends`
hierarchy, with fields flattened down) deploy exactly as they do for BigQuery,
but with bare table and graph names. Three things do not make the trip, all by
design:

- **Metrics.** Spanner has no `MEASURE`, so a Spanner deployment uses a profile
  that excludes every metric, and push rejects one that leaves a metric
  available. The BigQuery-only rule that a metric resolve to one
  entity does not apply. Author your metrics as usual — a BigQuery target still
  emits them, and Knowledge Catalog still records each `semantic-metric` entry —
  they simply have no home in the Spanner graph.
- **`OPTIONS` metadata.** Spanner carries no per-element `OPTIONS`, so
  `description`, `synonyms`, `instructions`, `examples`, and field `label` are not
  written into the Spanner DDL. They still reach Knowledge Catalog on the same
  push (the model's / entities' / metrics' descriptions and `instructions` land
  on their entries and the `guidelines` aspect), so the descriptive layer lives in
  the catalog rather than in the Spanner graph. This mirrors how BigQuery drops
  its graph-*statement* `OPTIONS` while keeping per-element ones.
- **Another engine's SQL.** A field reads its `SPANNER` expression, else its
  `ANSI_SQL` one, and is left out with a warning when it has neither.

Everything else — keys, relationships, the label hierarchy — matches the
**→ BigQuery** column above.

**Actions and constraints** reach neither graph. They are published to
Knowledge Catalog as one `semantic-action` or `semantic-constraint` entry each
and round-trip losslessly through `pull` — see
[To Knowledge Catalog](#to-knowledge-catalog).

## What pull recovers

`pull` rebuilds the model file from the catalog metadata that the rest of this
section describes. Comments, key order and formatting are not kept.
[Pull](README.md#pull) says when `pull` refuses the catalog instead.

With the second-generation types (the default), pull rebuilds the model file,
profile files and overview sidecars from the metadata, and writes each metric's
entity as `entity:`, declared or derived. See
[Reference](reference.md#the-second-generation-types). A model an older `kcmd`
pushed is left out with a warning.

`pull` returns what push wrote — the **Recovered by `pull`** column above is the
summary. Two things about *how* it comes back:

**Normalized** — the content survives, the form changes:

- Relationship *names* come back lowercased (`Places_Order` →
  `places_order`); the catalog stores the name only in the link id. See
  [Writer-side follow-up](#writer-side-follow-up).
- Field types round-trip except one collapse: a field authored as `String`
  comes back un-typed (both no type and `String` store `dataType STRING`, and
  `pull` writes no `datatype` for either; see footnote ²). A metric's data
  type round-trips only for a concrete type (e.g. `Decimal`); an untyped,
  `String`, or `Opaque` metric comes back un-typed, because the metric aspect
  stores a data type but no metadata type to mark it `Opaque`.
- When rebuilding from v1 catalog metadata (`KC_V2_ASPECTS=0`), a field's
  dimension role is omitted because the v1 `schema` aspect carries no
  per-field `semantics` block.
- Ordering: field order within each entity is preserved, but the order of
  entities and metrics is not — they come back in the catalog's own order, not
  the authored one. Comments in the original YAML are not preserved.

**So a file rebuilt from the metadata is not your original file.** Treat a
rebuilt document as a faithful copy of the catalog metadata rather than of the
authored model, and keep the authored document as the source of truth.

## Writer-side follow-up

One reduction above is a limit of what push currently *writes* rather than of
what pull can recover. It is recorded here as a write-side follow-up; the reader
(pull) already returns everything the catalog holds.

- **Relationship names.** The `schema-join` aspect type's `metadataTemplate` has
  no field for the relationship name, so push cannot store it and pull recovers
  it from the link id — which is lowercased, with each underscore written as a
  hyphen (the entry-link id format forbids both). Pull reads each hyphen back
  as an underscore, but the original casing is lost. Returning the name verbatim
  requires adding a name field to the built-in `schema-join` aspect type in
  Knowledge Catalog (server-side), after which the client write/read is trivial.

(A deployment target in no supported form is **not** a pull gap. Every push
rejects it at the validation gate before anything is written, a catalog-only
push (`--no-deployment`) too; see [Validation](reference.md#validation).)
