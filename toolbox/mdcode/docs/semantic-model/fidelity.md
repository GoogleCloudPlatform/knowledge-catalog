# What push and pull preserve

Your model document is the source of truth. Pushing it (to BigQuery and to
Knowledge Catalog) and pulling it back are each **lossy in specific ways**: the
graph keeps what it can query, the catalog keeps metadata, and `pull` can only
return what the catalog was given. This page is the one authoritative map of what
survives each direction. Keep your authored document.

## The round-trip matrix

Rows are what you authored; columns are its fate in each direction. `✓` = comes
back as authored; `—` = not present in that destination. Footnotes carry the
nuances that don't fit a cell.

| Authored element | → BigQuery graph | → Knowledge Catalog | Recovered by `pull` |
|---|---|---|---|
| Entity (name, `source`) | `NODE TABLE` | `semantic-entity` entry | ✓ |
| Field | column on the node table¹ | `schema` aspect column | ✓ (type collapses²) |
| Field `label` | into `OPTIONS(description)` | `schema` per-field annotation | ✓ |
| Field expression (canonical SQL) | builds the DDL | only with `--emit-expressions` | only if pushed with it |
| Field dimension role (`is_time`) | noted in `OPTIONS(description)` | only with `--emit-expressions`³ | only if pushed with it³ |
| Primary key | `KEY(...)` on the node table | `schema.primaryKey` | ✓ |
| Unique keys | — dropped (only PK emitted) | `schema.uniqueConstraints` | ✓ |
| Metric | `MEASURE`⁴ | `semantic-metric` entry | name, entity, description, instructions, type⁵ |
| Relationship (1:1 / 1:N) | `EDGE TABLE` | `schema-join` link | ✓ (name normalized⁶) |
| Relationship (M:N / `association`) | `EDGE TABLE` (via junction table) | — not stored | — |
| Entity `extends` | `LABEL` clauses + flattened fields | — not modelled | — |
| `description` (entity / metric / field / relationship) | `OPTIONS(description)` | entry description / aspect | ✓ |
| `ai_context.synonyms` | `OPTIONS(synonyms=[...])` | — not stored | — |
| `ai_context.instructions` | into `OPTIONS(description)` | `guidelines` aspect⁷ | ✓⁷ |
| `ai_context.examples` | into `OPTIONS(description)` (`Examples:` line) | — not stored | — |
| Model-level `description` / `instructions` | — dropped⁸ | on the model entry | ✓⁸ |
| Model-level `ai_context.synonyms` / `examples` | — dropped | — not stored | — |
| Deployment target | names the graph | recorded on the model entry | ✓ |
| Imported vendor SQL (`importedExpression` / `importedDialect`) | fallback — builds the DDL only when no canonical `expression` exists | — not stored | — |
| `custom_extensions` (beyond the deployment target) | — not in graph | — not stored | — |

¹ BigQuery uses the source column's own type; a field's authored `datatype` is not carried.
² Field types round-trip except two collapses: no type → `Opaque`, and `String` → un-typed. Both store as `dataType STRING`, disambiguated by `metadataType` (`OTHER` → read back as `Opaque`; `STRING` → read back un-typed) — which is exactly what lets them round-trip differently.
³ The default push omits the per-field `semantics` block, so the dimension role is written only with `--emit-expressions` — and then comes back as a bare `dimension: {}` marker (without `is_time`, and so on). A default push drops the marker entirely.
⁴ A metric must resolve to exactly one entity (otherwise the push is rejected) and reduce to one supported aggregate — `SUM` / `AVG` / `COUNT` / `MIN` / `MAX` — over one operand (otherwise it is skipped with a warning).
⁵ A metric's expression is gated behind `--emit-expressions`; its data type round-trips only for a concrete type (e.g. `Decimal`) — an untyped, `String`, or `Opaque` metric comes back un-typed.
⁶ Relationship names come back lowercased/hyphenated (`Places Order` → `places-order`) — the catalog stores the name only in the link id. See [Writer-side follow-up](#writer-side-follow-up).
⁷ The `guidelines` aspect exists only for the model, entities, and metrics — not fields or relationships, so field- and relationship-level `ai_context.instructions` has no Knowledge Catalog home (a relationship's instructions still reach BigQuery, folded into the edge's `OPTIONS(description)`).
⁸ BigQuery silently drops statement-level graph `OPTIONS`, so model-level metadata has no home in the graph; the model's `description` and `ai_context.instructions` are carried into Knowledge Catalog instead.

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

## To Knowledge Catalog

The catalog holds metadata, not a full copy of your model. Every resource type it
uses is a built-in system type under `dataplex-types/global` — push references
them, it never creates them (see
[Reference → What gets created in Knowledge Catalog](reference.md#what-gets-created-in-knowledge-catalog)).

By default it does **not** store the SQL expressions: the published system-type
templates do not yet carry a per-field `semantics` block or a
`semantic-metric.expression` field, so the default push omits them. Pass
`--emit-expressions` to write the canonical GoogleSQL/ANSI expression once the
templates gain the fields. It never stores `ai_context.synonyms`/`examples`,
field-level `ai_context` (only model/entity/metric `instructions` have a home, in
the `guidelines` aspect), or the original vendor SQL (`importedExpression` — e.g.
the MAQL or Snowflake form a metric was imported from). Those stay in your
authored document; the vendor SQL and expressions are still used when generating
BigQuery SQL.

## What pull recovers

`pull` returns what push wrote — the **Recovered by `pull`** column above is the
summary. Two things about *how* it comes back:

**Normalized** — the content survives, the form changes:

- Relationship *names* come back lowercased/hyphenated (`Places Order` →
  `places-order`); the catalog stores the name only in the link id. See
  [Writer-side follow-up](#writer-side-follow-up).
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
pulled document as a faithful copy of the catalog metadata, not of the authored
model, and keep the authored document as the source of truth.

## Writer-side follow-up

One reduction above is a limit of what push currently *writes*, not of what pull
can recover. It is recorded here as a write-side follow-up; the reader (pull)
already returns everything the catalog holds.

- **Relationship names.** The `schema-join` aspect type's `metadataTemplate` has
  no field for the relationship name, so push cannot store it and pull recovers
  it from the link id — which is lowercased and hyphenated (the entry-link id
  format forbids the original casing/underscores). Returning the name verbatim
  requires adding a name field to the built-in `schema-join` aspect type in
  Knowledge Catalog (server-side), after which the client write/read is trivial;
  it is the same class of gap as the `semantics` field that gates
  `--emit-expressions`.

(A non-canonical deployment target is **not** a pull gap: push rejects it at the
validation gate before any leg runs, so it is never written — see
[Validation](reference.md#validation).)
