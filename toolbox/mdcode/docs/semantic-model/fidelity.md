# What push and pull preserve

Your model document is the source of truth. Pushing it — to Knowledge Catalog
and to a property graph in BigQuery or Spanner — and pulling it back are each
**lossy in specific ways**. The catalog keeps metadata, the graph keeps what it
can query, and `pull` can only return what the catalog was given. This page is
the one authoritative map of what survives each direction. Keep your authored
document.

Which backend a push deploys to — BigQuery or Spanner — is set by the model's
deployment target, or by the binding profile you select; it is not a
command-line flag. What reaches Knowledge Catalog depends on the push as well: a
catalog-only or purely logical push records the whole model, while a push that
also deploys a graph records only the part the graph binds. Both effects are
detailed under [To Knowledge Catalog](#to-knowledge-catalog).

## The round-trip matrix

Rows are what you authored; columns are its fate in each direction. `✓` = comes
back as authored; `—` = not present in that destination. Footnotes carry the
nuances that don't fit a cell. BigQuery and Spanner each get a column; they
agree on every structural row and differ only where a Spanner target has no
`MEASURE` and no `OPTIONS` metadata — see [To Spanner](#to-spanner).

| Authored element                                               | → Knowledge Catalog             | Recovered by `pull`                            | → BigQuery                                                           | → Spanner                                                            |
|----------------------------------------------------------------|---------------------------------|------------------------------------------------|----------------------------------------------------------------------|----------------------------------------------------------------------|
| Entity (name, `source`)                                        | `semantic-entity` entry¹⁰       | ✓                                              | `NODE TABLE`                                                         | `NODE TABLE`                                                         |
| Field                                                          | `schema` aspect column          | ✓ (type collapses²)                            | column on the node table¹                                            | column on the node table¹                                            |
| Field `label`                                                  | `schema` per-field annotation   | ✓                                              | into `OPTIONS(description)`                                          | — dropped                                                            |
| Field expression (canonical SQL)                               | only with `--emit-expressions`  | only if pushed with it                         | builds the DDL                                                       | builds the DDL                                                       |
| Field dimension role (`is_time`)                               | only with `--emit-expressions`³ | only if pushed with it³                        | noted in `OPTIONS(description)`                                      | — dropped                                                            |
| Primary key                                                    | `schema.primaryKey`             | ✓                                              | `KEY(...)` on the node table                                         | `KEY(...)` on the node table                                         |
| Unique keys                                                    | `schema.uniqueConstraints`      | ✓                                              | — dropped (only PK emitted)                                          | — dropped (only PK emitted)                                          |
| Metric                                                         | `semantic-metric` entry         | name, entity, description, instructions, type⁵ | `MEASURE`⁴                                                           | — dropped (no `MEASURE`)                                             |
| Relationship (foreign key)                                     | `semantic-relationship` entry⁶  | ✓                                              | `EDGE TABLE`                                                         | `EDGE TABLE`                                                         |
| Relationship (`through` a table of pairs)                      | `semantic-relationship` entry⁶  | ✓¹³                                            | `EDGE TABLE` over that table                                         | `EDGE TABLE` over that table                                         |
| Entity `extends`                                               | — not modelled                  | —                                              | `LABEL` clauses + flattened fields                                   | `LABEL` clauses + flattened fields                                   |
| Action                                                         | `semantic-action` entry¹²       | ✓¹²                                            | — not represented (write-side)                                       | — not represented (write-side)                                       |
| `description` (entity / metric / field / relationship)         | entry description / aspect      | ✓                                              | `OPTIONS(description)`                                               | — dropped                                                            |
| `ai_context.synonyms`                                          | — not stored                    | —                                              | `OPTIONS(synonyms=[...])`                                            | — dropped                                                            |
| `ai_context.instructions`                                      | `guidelines` aspect⁷            | ✓⁷                                             | into `OPTIONS(description)`                                          | — dropped                                                            |
| `ai_context.examples`                                          | — not stored                    | —                                              | into `OPTIONS(description)` (`Examples:` line)                       | — dropped                                                            |
| Model-level `description` / `instructions`                     | on the model entry              | ✓⁸                                             | — dropped⁸                                                           | — dropped⁸                                                           |
| Model-level `ai_context.synonyms` / `examples`                 | — not stored                    | —                                              | — dropped                                                            | — dropped                                                            |
| Deployment target                                              | recorded on the model entry     | ✓                                              | names the graph                                                      | names the graph                                                      |
| Vendor-dialect `expression` variant (non-canonical `dialects[]` entry)¹¹ | — not stored          | —                                              | fallback — builds the DDL only when no canonical `expression` exists | fallback — builds the DDL only when no canonical `expression` exists |
| `custom_extensions` (beyond the deployment target)             | — not stored                    | —⁹                                             | — not in graph                                                       | — not in graph                                                       |

1. **Field type source.** The graph uses the source column's own type; a
   field's authored `datatype` is not carried.
2. **Field type collapses.** Field types round-trip except two collapses: no
   type → `Opaque`, and `String` → un-typed. Both store as `dataType STRING`,
   disambiguated by `metadataType` (`OTHER` → read back as `Opaque`; `STRING` →
   read back un-typed) — which is what lets them round-trip differently.
3. **Dimension role.** The default push omits the per-field `semantics` block,
   so the dimension role is written only with `--emit-expressions` — and then
   comes back as a bare `dimension: {}` marker (without `is_time`, and so on). A
   default push drops the marker entirely.
4. **Metric shape.** A metric must resolve to exactly one entity (otherwise the
   push is rejected) and reduce to one supported aggregate — `SUM` / `AVG` /
   `COUNT` / `MIN` / `MAX` — over one operand (otherwise it is skipped with a
   warning).
5. **Metric type.** A metric's expression is gated behind `--emit-expressions`;
   its data type round-trips only for a concrete type (e.g. `Decimal`) — an
   untyped, `String`, or `Opaque` metric comes back un-typed.
6. **Relationship storage.** Every relationship is stored as one
   `semantic-relationship` entry under the model entry, holding both endpoints,
   the join columns, and the relationship's `instructions`. A relationship
   carried by a foreign key *also* gets a `schema-join` link, so Dataplex
   surfaces that read joins still see it; the entry is the fidelity record and
   the link the graph-shaped projection. Because the name rides the entry, it
   comes back verbatim — a link could only ever return the lowercased,
   hyphenated form of its id.
7. **Guidelines aspect.** The `guidelines` aspect exists only for the model,
   entities, and metrics — not fields, so field-level
   `ai_context.instructions` has no Knowledge Catalog home. A relationship's
   instructions ride its own `semantic-relationship` aspect instead: that aspect
   type is ours, so it has a field for them.
8. **Model-level metadata.** Neither graph has a home for statement-level
   metadata — BigQuery silently drops graph-statement `OPTIONS`, and Spanner
   carries no `OPTIONS` at all — so the model's `description` and
   `ai_context.instructions` are carried into Knowledge Catalog instead.
9. **Other custom extensions.** Under the vanilla `0.2.0.dev0` profile a
   `custom_extensions` block (other than a GOOGLE deployment target) is the only
   carrier for vendor metadata; it is inert on push and not persisted to
   Knowledge Catalog, so `pull` never recovers it. `pull` also emits the extended
   `0.2.0.dev0/google` profile, which has no `custom_extensions` carrier, so such
   a block is not re-serialized either — keep your authored file. The OWL importer
   emits none: it is import-only (see [Importing an OWL
   ontology](owl-import.md)).
10. **Logical (unbound) model.** A model with no bindings still publishes to
    Knowledge Catalog: each entity's `source` is recorded empty (`resources: []`)
    because there is no table behind it, and a relationship that carries no join
    columns publishes as an entry with none (it gets no `schema-join` link, which
    requires a column pair). When the same push also deploys a graph,
    the catalog entries are first pruned to what the graph binds — see
    [To Knowledge Catalog](#to-knowledge-catalog).
11. **Vendor-dialect fallback.** What you author is the `expression.dialects[]`
    list; the graph builds from the canonical (BigQuery/ANSI) variant.
    `importedExpression` / `importedDialect` are not authored keys — the loader
    *derives* them from a non-canonical dialect entry (for example the MAQL or
    Snowflake form a metric was imported from) and uses that verbatim as the
    fallback when no canonical variant exists. See
    [Model spec §2.5](model_spec.md#25-expressions).
12. **Actions.** Actions are write-side, so neither graph has a construct for
    them: the push emits nothing for an action and warns once. They are
    published to Knowledge Catalog as one `semantic-action` entry each, under
    the model entry, and `pull` reads them back from those entries. Prototype
    scope: an action's `precondition` and `affects` are not modelled, so nothing
    about them is stored either way. See
    [Modeling write operations](actions.md).
13. **Relationships through a table of pairs.** A relationship with a `through`
    table gets no `schema-join` link: that link holds exactly one source/target
    column pair, which cannot describe an edge running through a third table. Its
    entry carries the rest — the `through` table, its key, and the fields of the
    pairing — so the whole relationship round-trips, the edge's own field
    expressions included. Those are stored unconditionally: the aspect type is
    ours, so it has fields for them, where the `--emit-expressions` gate exists
    for the published system templates that do not. See
    [Model spec §2.2.1](model_spec.md#221-many-to-many-through).

## To Knowledge Catalog

The catalog holds metadata rather than a full copy of your model. Every resource
type it uses is a built-in system type under `dataplex-types/global`, apart from
the custom `semantic-relationship` and `semantic-action` pairs that `kcmd init`
provisions — push references
types, it never creates them (see
[Reference → What gets created in Knowledge Catalog](reference.md#what-gets-created-in-knowledge-catalog)).

What is recorded depends on the push. A catalog-only push (`--no-profile`), or a
purely logical model with no bindings, records the whole model: every entity,
metric, and relationship the document declares. A push that also deploys a graph
first prunes the model to what that graph binds, so an unbound field — and any
entity, metric, or relationship that depends on it — is left out of the catalog
entries too. A pull of such a push returns the bound view rather than the full
authored model.

A logical model still produces complete entries. Each entity's `source` is
recorded empty (`resources: []`) because there is no table behind it, and a
relationship that carries no join columns publishes as an entry with none.

By default the catalog does **not** store the SQL expressions: the published
system-type templates do not yet carry a per-field `semantics` block or a
`semantic-metric.expression` field, so the default push omits them. Pass
`--emit-expressions` to write the canonical GoogleSQL/ANSI expression once the
templates gain the fields. The catalog never stores `ai_context.synonyms` /
`examples`, field-level `ai_context` (only model, entity, and metric
`instructions` have a home, in the `guidelines` aspect), or the original vendor
SQL (`importedExpression` — for example the MAQL or Snowflake form a metric was
imported from). Those stay in your authored document; the vendor SQL and
expressions are still used when generating graph SQL.

**Relationships** get an entry rather than a link. A `schema-join` link holds one
source/target column pair, which cannot describe an edge running through a table
of pairs, and it has no field for the relationship's name; Knowledge Catalog has
no custom *link* types either — only custom entry and aspect types. So each
relationship becomes a `semantic-relationship` entry under the model entry,
carrying the two entities it pairs, the join columns, and, when there is one, the
`through` table with its key and fields. All of it round-trips through `pull`,
name included. A relationship carried by a foreign key also keeps its
`schema-join` link, for the Dataplex surfaces that read joins. The entry type is
custom, so `kcmd init` creates it; a model with no relationships never needs
it.

**Actions** follow the same one-entry-per-element rule as everything else: each
becomes a `semantic-action` entry under the model entry, carrying its executor
and typed parameters in a `semantic-action` aspect. They round-trip losslessly
through `pull` (name, description, executor, typed parameters, and
`instructions`). Their `precondition` / `affects` are out of scope for this
prototype and are not stored. The entry type is custom, so `kcmd init` creates
it; a model that declares no action never needs it.

¹⁰ What you author is the `expression.dialects[]` list; the graph builds from the canonical (BigQuery/ANSI) variant. `importedExpression` / `importedDialect` are not authored keys — the loader *derives* them from a non-canonical dialect entry (e.g. the MAQL or Snowflake form a metric was imported from) and uses that verbatim as the fallback when no canonical variant exists. See [Model spec §2.5](model_spec.md#25-expressions).

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
into Knowledge Catalog instead. Unique keys beyond the primary key are also
dropped (only the primary key is emitted). The imported vendor SQL is not carried
as a separate form: the graph builds from the canonical `expression` when
present, and falls back to the imported vendor SQL verbatim only when the model
was never transpiled to a canonical form.

## To Spanner

A Spanner target keeps the queryable **structure** and drops the descriptive
metadata. The node tables, edge tables, and labels (including the `extends`
hierarchy, with fields flattened down) deploy exactly as they do for BigQuery,
but with bare table and graph names. Two things do not make the trip, both by
design:

- **Metrics.** Spanner has no `MEASURE`, so every model-level metric is
  dropped with a warning. The BigQuery-only rule that a metric resolve to one
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

Everything else — keys, relationships, the label hierarchy — matches the
**→ BigQuery** column above.

**Actions** reach neither graph. They are published to Knowledge Catalog as one
`semantic-action` entry each and round-trip losslessly through `pull` — see
[To Knowledge Catalog](#to-knowledge-catalog).

## What pull recovers

`pull` returns what push wrote — the **Recovered by `pull`** column above is the
summary. When the push deployed a graph, what push wrote was already pruned to
the bound view (see [To Knowledge Catalog](#to-knowledge-catalog)), so pull
returns that view. Two things about *how* it comes back:

**Normalized** — the content survives, the form changes:

- Field types round-trip except two collapses: a field authored with no type
  comes back as `Opaque`, and a field authored as `String` comes back un-typed
  (both store `dataType STRING`, kept distinct by a field's `metadataType` — see
  footnote ²). A metric's data
  type round-trips only for a concrete type (e.g. `Decimal`); an untyped,
  `String`, or `Opaque` metric comes back un-typed, because the metric aspect
  stores a data type but no metadata type to mark it `Opaque`.
- A field's dimension role (present only if pushed with `--emit-expressions`)
  comes back as a bare `dimension: {}` marker, without its detail (`is_time`, and
  so on).
- Ordering: field order within each entity is preserved, but the order of
  entities and metrics is not — they come back in the catalog's own order, not
  the authored one. Comments in the original YAML are not preserved.

**So a push followed by a pull does not return your original file.** Treat a
pulled document as a faithful copy of the catalog metadata rather than of the
authored model, and keep the authored document as the source of truth.

(A non-canonical deployment target is **not** a pull gap: push rejects it at the
validation gate before any leg runs, so it is never written — see
[Validation](reference.md#validation).)
