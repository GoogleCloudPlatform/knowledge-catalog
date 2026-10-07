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
also deploys a graph records only the part the graph binds — and whichever way
you push, only one binding is recorded, even when the model defines several. All
three are detailed under [To Knowledge Catalog](#to-knowledge-catalog).

A model imported from an OWL ontology or SHACL shapes has already lost
something before any push. [What an import keeps](#what-an-import-keeps-proposed)
follows each imported construct through the import's coverage report and on to
what it becomes in a BigQuery graph.

## The round-trip matrix

Rows are what you authored; columns are its fate in each direction. `✓` = comes
back as authored; `—` = not present in that destination. Footnotes carry the
nuances that don't fit a cell. BigQuery and Spanner each get a column; they
agree on every structural row and differ only where a Spanner target has no
`MEASURE` and no `OPTIONS` metadata — see [To Spanner](#to-spanner).

| Authored element                                               | → Knowledge Catalog             | Recovered by `pull`                            | → BigQuery                                                           | → Spanner                                                            |
|----------------------------------------------------------------|---------------------------------|------------------------------------------------|----------------------------------------------------------------------|----------------------------------------------------------------------|
| Entity (name, `source`)                                        | `semantic-entity` entry¹⁰       | ✓                                              | generated node view + `NODE TABLE` over it¹⁹                         | `NODE TABLE`                                                         |
| Field                                                          | `schema` aspect column          | ✓ (type collapses²)                            | column on the node table¹                                            | column on the node table¹                                            |
| Field `label`                                                  | `schema` per-field annotation   | ✓                                              | into `OPTIONS(description)`                                          | — dropped                                                            |
| Field expression (canonical SQL)                               | `semantic-expressions` aspect²⁰ (else only with `--emit-expressions`) | ✓²⁰ (else only if pushed with it) | builds the DDL                                                       | builds the DDL                                                       |
| Field dimension role (`is_time`)                               | `semantic-expressions` aspect²⁰ (else only with `--emit-expressions`³) | ✓²⁰ (else only if pushed with it³) | noted in `OPTIONS(description)`                                      | — dropped                                                            |
| Primary key                                                    | `schema.primaryKey`             | ✓                                              | `KEY(...)` on the node table                                         | `KEY(...)` on the node table                                         |
| Unique keys                                                    | `schema.uniqueConstraints`      | ✓                                              | — dropped (only PK emitted)                                          | — dropped (only PK emitted)                                          |
| Metric                                                         | `semantic-metric` entry (+ `semantic-expressions`²⁰) | ✓²⁰ (else name, entity, description, instructions, type⁵) | `MEASURE`⁴                                                           | — dropped (no `MEASURE`)                                             |
| Relationship (1:1 / 1:N)                                       | `schema-join` link (+ name / `ai_context` on the model's `semantic-ai-context`²⁰) | ✓²⁰ (else name normalized⁶) | `EDGE TABLE`                                                         | `EDGE TABLE`                                                         |
| Relationship (M:N / `association`)                             | junction `semantic-entity` entry (`<model>.associations.<rel>`) + two `schema-join` links²⁰ | ✓²⁰ | `EDGE TABLE` (via junction table)                                    | `EDGE TABLE` (via junction table)                                    |
| Entity `extends`                                               | `Specializes:` description paragraph¹⁵ | ✓¹⁵                                     | `LABEL` clauses + flattened fields                                   | `LABEL` clauses + flattened fields                                   |
| Entity `abstract`                                              | table-less `semantic-entity` entry + `Abstract:` paragraph¹⁵ | ✓¹⁵                 | — no node table (a label on its subtypes)                            | — no node table (a label on its subtypes)                            |
| Field `unit` / `scale`                                         | `Unit: USD (x1000).` trailer on the `schema` field description | ✓ (trailer peeled off) | into column `OPTIONS(description)`                              | — dropped                                                            |
| Entity `grain` / `history`                                     | `Grain:` / `History:` paragraphs on the entry description | ✓ (paragraphs peeled off) | into node label `OPTIONS(description)`; the node table stays the all-versions table | — dropped                                    |
| Entity `members` (vocabulary, proposed)                         | `Members:` paragraph on the entry description¹⁷ + full members on `semantic-binding`²⁰ | ✓²⁰ (else codes and labels¹⁷) | generated `vocab_<entity>` view + `NODE TABLE` over it; edges into it via generated views¹⁷ | — push error without a `source`¹⁷ |
| Relationship `via` / `filter` (derived, proposed)              | `schema-join` over the endpoint keys + `Derived via:` / `Derived filter:` paragraphs¹⁸ | ✓ (step names normalized⁶)¹⁸ | generated `edge_<relationship>` view + `EDGE TABLE` over it¹⁸ | — push error¹⁸ |
| Entity `hydration` / `mode` (binding)                          | `Hydration:` paragraph¹⁹ + structured `semantic-binding` aspect²⁰; binding links to the node view / table and graph node entries²⁰ | ✓¹⁹ ²⁰ | the generated node view's rows (`mode: direct`: the source table as-is)¹⁹ | — tables bound as-is; `derive_from` is a push error¹⁹ |
| Action                                                         | `semantic-action` entry¹²       | ✓¹²                                            | — not deployed¹²                                                     | — not deployed¹²                                                     |
| Constraint                                                     | `semantic-constraint` entry¹³   | ✓¹³                                            | — not deployed¹³                                                     | — not deployed¹³                                                     |
| Glossary (`glossary:`)                                         | Business Glossary, categories, terms and `related` / `definition` entry links, via `kcmd glossary push`¹⁶ | — not yet¹⁶ | — not deployed¹⁶ | — not deployed¹⁶ |
| `description` (entity / metric / field / relationship)         | entry description / aspect      | ✓                                              | `OPTIONS(description)`                                               | — dropped                                                            |
| `ai_context.synonyms`                                          | `semantic-ai-context` aspect²⁰ (else not stored) | ✓²⁰                                  | `OPTIONS(synonyms=[...])`                                            | — dropped                                                            |
| `ai_context.instructions`                                      | `guidelines` aspect⁷            | ✓⁷                                             | into `OPTIONS(description)`                                          | — dropped                                                            |
| `ai_context.examples`                                          | `semantic-ai-context` aspect²⁰ (else not stored) | ✓²⁰                                  | into `OPTIONS(description)` (`Examples:` line)                       | — dropped                                                            |
| Model-level `description` / `instructions`                     | on the model entry              | ✓⁸                                             | — dropped⁸                                                           | — dropped⁸                                                           |
| Model-level `ai_context.synonyms` / `examples`                 | `semantic-ai-context` on the model entry²⁰ (else not stored) | ✓²⁰                      | — dropped                                                            | — dropped                                                            |
| Deployment target                                              | recorded on the model entry     | ✓                                              | names the graph                                                      | names the graph                                                      |
| Binding profile (alternate physical binding)                   | — only the selected one¹⁴       | —¹⁴                                            | one graph per BigQuery-bound profile                                 | one graph per Spanner-bound profile                                  |
| Vendor-dialect `expression` variant (non-canonical `dialects[]` entry)¹¹ | — not stored          | —                                              | fallback — builds the DDL only when no canonical `expression` exists | fallback — builds the DDL only when no canonical `expression` exists |
| `custom_extensions` (beyond the deployment target)             | — not stored                    | —⁹                                             | — not in graph                                                       | — not in graph                                                       |

1. **Field type source.** The graph uses the source column's own type; a
   field's authored `datatype` is not carried.
2. **Field type collapses.** Field types round-trip except two collapses: no
   type → `Opaque`, and `String` → un-typed. Both store as `dataType STRING`,
   disambiguated by `metadataType` (`OTHER` → read back as `Opaque`; `STRING` →
   read back un-typed) — which is what lets them round-trip differently.
3. **Dimension role.** Without the `semantic-expressions` aspect²⁰, the
   default push omits the per-field `semantics` block, so the dimension role
   is written only with `--emit-expressions` — and then comes back as a bare
   `dimension: {}` marker (without `is_time`, and so on). A default push drops
   the marker entirely. With the aspect, the role and `is_time` round-trip.
4. **Metric shape.** A metric must resolve to exactly one entity (otherwise the
   push is rejected) and reduce to one supported aggregate — `SUM` / `AVG` /
   `COUNT` / `MIN` / `MAX` — over one operand (otherwise it is skipped with a
   warning). That is the main graph; the metric graphs deployed next to it
   (proposed) also carry a formula over several aggregates, as single-aggregate
   component measures plus a composition — see
   [Metric graphs for `GRAPH_EXPAND`](#metric-graphs-for-graph_expand-proposed).
5. **Metric type.** Without the `semantic-expressions` aspect²⁰, a metric's
   expression is gated behind `--emit-expressions`, and its data type
   round-trips only for a concrete type (e.g. `Decimal`) — an untyped,
   `String`, or `Opaque` metric comes back un-typed. With the aspect, the
   expression, the imported vendor SQL and the exact type round-trip.
6. **Relationship name.** Without the `semantic-ai-context` aspect²⁰,
   relationship names come back lowercased/hyphenated (`Places Order` →
   `places-order`) — the link id is then the only place the name is stored.
   With the aspect, the model entry carries a relationship index (authored
   name, link id, `ai_context`, in source order), and pull restores the names
   verbatim. See [Writer-side follow-up](#writer-side-follow-up).
7. **Guidelines aspect.** The `guidelines` aspect exists only for the model,
   entities, and metrics — not fields or relationships. Field- and
   relationship-level `ai_context` (instructions included) is stored on the
   `semantic-ai-context` aspect²⁰ of the owning entity entry (fields) or of
   the model entry (relationships); without it, it has no Knowledge Catalog
   home (a relationship's instructions still reach BigQuery, folded into the
   edge's `OPTIONS(description)`).
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
    columns is skipped with a warning. When the same push also deploys a graph,
    the catalog entries are first pruned to what the graph binds — see
    [To Knowledge Catalog](#to-knowledge-catalog).
11. **Vendor-dialect fallback.** What you author is the `expression.dialects[]`
    list; the graph builds from the canonical (BigQuery/ANSI) variant.
    `importedExpression` / `importedDialect` are not authored keys — the loader
    *derives* them from a non-canonical dialect entry (for example the MAQL or
    Snowflake form a metric was imported from) and uses that verbatim as the
    fallback when no canonical variant exists. See
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
14. **Binding profiles.** A model may define several physical realizations, one
    per binding profile. `--all-profiles` deploys a graph for every profile that
    declares a deployment target, each to the backend its own target names; a
    profile without one is skipped, and two profiles claiming the same graph are
    rejected before anything deploys. Knowledge Catalog still records a single
    binding — the one named by `--profile`, else the default binding, which is
    what an `--all-profiles` run always records, the two flags being mutually
    exclusive. See [Binding profiles](profiles.md).
15. **Class hierarchy on the catalog.** Neither closed entity template has a
    slot for a supertype, so each entity that `extends` others ends its entry
    description with a `Specializes: Party, Auditable.` paragraph, and an
    `abstract` entity — published as a table-less entry (`resources: []`, its
    own fields, no key) — ends it with `Abstract: no table of its own.`. Pull
    peels both off, restoring `extends` and `abstract`, so the pulled model
    loads strictly. A parent the pull did not recover is dropped from `extends`
    with a warning. Inherited fields are not flattened onto a subtype's entry:
    each entry lists the fields it declares. A relationship with an abstract
    endpoint publishes no link (there is no table behind that end); with the
    `semantic-ai-context` aspect²⁰ it rides the model entry instead.
16. **Business glossary.** `kcmd push` does not publish the `glossary:` block;
    `kcmd glossary push` does, as a Dataplex Business Glossary with categories
    and terms. A term's synonyms, formula, related terms, defined elements and
    source go into trailers on its description, so catalog search finds them.
    `related` becomes `related` entry links and `defines` becomes `definition`
    entry links to the BigQuery table (with a `Schema.<column>` path for a
    field) and to the semantic entry. When the API refuses a `definition`
    link on the `semantic-entity` / `semantic-metric` entry, `kcmd glossary
    push` links the bound node view instead (its column for a field, the
    whole view for a metric) and reports the substitution; a `mode: direct`
    entity has no node view, so its refusal is reported as before. A reader
    (`glossaryFromDataplex`) peels
    the trailers off again, but `kcmd pull` does not call it yet. The OSI
    export carries the block as is. See [Business glossary](glossary.md).
17. **Vocabulary members (proposed).** Neither closed entity template has a
    slot for a member list, so a vocabulary's entry description ends with a
    `Members: "OPEN" — "Open"; "VOID" — "Cancelled".` paragraph (codes and
    labels as JSON strings, `Members: none.` for an empty list). Pull peels it
    off and restores `members` with codes and labels in paragraph order. Each
    member's `order`, `synonyms`, `definition` and `iri` are not in the
    paragraph; they round-trip through the `semantic-binding` aspect²⁰ when it
    is provisioned. Without it, a pulled model re-deploys its view with
    `sort_order`, `definition` and `iri` NULL. Publishing members as Business
    Glossary terms is a follow-up. On
    BigQuery, kcmd generates the view `vocab_<snake_case(entity)>` (`code`,
    `label`, `sort_order`, `definition`, `iri`). It does so when the
    vocabulary has no `source`, or when the source's table name is that view
    name. The view is created before the graph, and the node table reads it.
    A vocabulary bound to any other table keeps that table, and its members
    only document it. A foreign-key edge into a vocabulary is backed by a
    generated `edge_<relationship>` view that matches the code
    case-insensitively. Spanner has no generated views: a vocabulary there
    needs a `source`. See [Extensions](model_spec.md#5-extensions).
18. **Derived relationships (proposed).** A derived relationship publishes
    a `schema-join` of type `JOIN` between its two endpoint entries. The join
    is keyed on the two entities' keys, since a chain has no foreign key of
    its own. Its description ends with `Derived via: ^memberOf, inClub.`, plus
    `Derived filter: <expression>` when it has a filter. Pull peels both off,
    restoring `via` and `filter`. The steps come back under the pulled
    (normalized⁶) relationship names, so the second push of a pulled model is
    a fixed point. On BigQuery, kcmd generates the view
    `edge_<snake_case(relationship)>`. It holds the distinct
    (`source_<key>`, `target_<key>`) pairs the chain reaches, and the edge
    table reads it. Some chains cannot be materialized, and the edge is then
    omitted with a warning:
    - a step through a junction or column-less edge;
    - an endpoint with no table;
    - a step that is itself derived with its own `filter`.

    Spanner rejects a derived relationship at push time. See
    [Extensions](model_spec.md#5-extensions).
19. **Hydration and binding mode.** Neither closed entity template has a slot
    for how a table is reshaped, so an entity with `hydration` rules or
    `mode: direct` ends its entry description with one
    `Hydration: latest version per opportunity_id by created_at; wonAmount
    ÷100 before 2024-03-25; homeMarketUnit resolved to MarketUnit by
    marketUnitCode or unitName.` paragraph (`derived from <relationship>`,
    `bound directly (no node view)` for the other forms). It is the last
    paragraph, after `Members:`. Pull peels it off and restores `hydration`
    and `mode`, and writes them back into the pulled document; a paragraph
    that does not parse in full is left in the description. An entity bound
    through a pass-through node view (the default) carries none. On BigQuery
    each bound entity's node table reads a generated node view whose
    description carries the same summary (see
    [Node views](reference.md#node-views-hydration)); a `derive_from` entity
    publishes a table-less entry (`resources: []`). Spanner binds tables as-is
    and rejects `derive_from` at push time. With the `semantic-binding`
    aspect²⁰ provisioned, the same rules are also stored as structured data,
    which pull prefers over the paragraph.
20. **Annotation aspects (lossless push / pull).** `kcmd init
    --semantic-model` provisions three aspect-only custom types next to the
    constraint and action types: `semantic-ai-context` (an element's whole
    `ai_context` — synonyms, examples, instructions — its fields'
    `ai_context`, and on the model entry the relationship index),
    `semantic-expressions` (field and metric expressions, imported vendor SQL,
    dimension role, exact logical type) and `semantic-binding` (binding mode,
    hydration rules, full vocabulary members, the node view / graph / node
    label the entity is read through; on a junction entry, the many-to-many
    relationship). A push attaches each one only when it is provisioned and
    the element has content for it; when `semantic-expressions` is present
    the expressions are written without `--emit-expressions`. Pull treats a
    present aspect as authoritative and falls back to the description
    trailers and built-in aspects otherwise, so a catalog pushed before the
    types existed (or a project where `init` was not re-run) reads back
    exactly as before. Independently of the aspects, a many-to-many
    relationship publishes a junction `semantic-entity` entry
    `<model>.associations.<relationship>` plus two `schema-join` links
    (`…-src`, `…-dst`) through it (without `semantic-ai-context` its name
    comes back normalized⁶). A relationship that publishes no link — an
    abstract one, or one with an abstract or column-less endpoint — rides the
    model entry's relationship index whole (endpoints, columns, `abstract`,
    `extends`, description, inverse, `via` / `filter`), so pull rebuilds it
    and its sub-relationships keep their `extends`. Each bound entity also
    gets binding links to its BigQuery node view (or, for `mode: direct`,
    its table) entry in `@bigquery` and to its graph node entry. Residual
    gaps:
    - without `semantic-ai-context`, a relationship that publishes no link is
      not recovered, and a sub-relationship naming it loses that `extends`;
    - a many-to-many relationship authored with empty side columns reads
      back with the endpoint keys filled in;
    - a relationship's `custom_extensions` is not persisted (see ⁹);
    - binding links fail (with a warning, not an error) until BigQuery has
      indexed the `@bigquery` entries of freshly created views — re-push to
      add them.

## What an import keeps (proposed)

The matrix starts from what you authored. An imported model loses something
earlier: an ontology or a shapes graph says more than a model can hold. Every
`kcmd owl import` and `kcmd shacl import` reports what became of each construct
occurrence it read, as `compiled`, `hinted` or `dropped` (see the coverage
reports of the [OWL import](owl-import.md#6-coverage-report-proposed) and the
[SHACL import](shacl-import.md#3-coverage-report-proposed)). The table follows
each construct through the import and on into a BigQuery graph. Its **Graph
lowering** column is the matrix's → BigQuery column applied to imported
content.

| Imported construct | Coverage outcome | Model element | Graph lowering (BigQuery) |
|---|---|---|---|
| `owl:Class` | compiled | entity | `NODE TABLE` once a profile binds it; an unbound entity has no table |
| `owl:Class` with no key (own or inherited) and subclasses (`owl:hasKey (absent)`), or `kcmd:abstract true` | compiled | entity `abstract: true` | no node table; a `LABEL` on its subtypes' node tables |
| keyless leaf `owl:Class` (`owl:hasKey (absent)`) | dropped (reported) | entity with no `primary_key` | no node table until the model gives it a key |
| `owl:equivalentClass` from an unkeyed class to a keyed one (`owl:equivalentClass (folded)`) | compiled | the keyed entity: relationships, fields and `extends` re-pointed, names as `ai_context.synonyms` | the keyed entity's node table and `OPTIONS(synonyms=[...])` |
| `rdfs:subClassOf` (named class) | compiled | entity `extends` | `LABEL` clauses on the subtype's node table, inherited fields flattened down |
| `rdfs:subClassOf` from a vocabulary to a class with fields | dropped | — (the vocabulary has no `extends` to it) | — |
| `owl:hasKey` | compiled | `primary_key` | `KEY(...)` on the node table |
| `owl:InverseFunctionalProperty` | compiled | `unique_keys` (inherited by concrete subclasses), or `primary_key` on a keyless class with no keyed subclass | — dropped (only the primary key is emitted), unless it became the primary key |
| `owl:DatatypeProperty` and its `rdfs:range` | compiled | field and its `datatype` | a property of the node table, typed by the bound column¹ |
| `owl:unionOf` as an `rdfs:domain` | compiled | the field on every member class | a property of each member's node table |
| `owl:FunctionalProperty` on a datatype property | compiled (by construction) | a field, which holds one value | a property, which holds one value |
| `qudt:unit` and the other unit annotations | compiled | field `unit` | a `Unit:` trailer in the property's `OPTIONS(description)` |
| `owl:ObjectProperty` | compiled | relationship | `EDGE TABLE` once the model gives it join columns and both ends are node tables |
| `encodedBy` on an object property | compiled | relationship `from_columns` / `to_columns` (the destination's single-column key, own or inherited) | the `EDGE TABLE`'s `SOURCE KEY` / `DESTINATION KEY` |
| `kcmd:Metric` individual | compiled | metric (`expression`, `description` with `Unit:`, `ai_context`); a glossary term when the model has a glossary | `MEASURE`⁴ |
| `owl:inverseOf` | compiled | relationship `inverse` | a second `EDGE TABLE` over the same backing table, `SOURCE` and `DESTINATION` swapped, no `OPTIONS` |
| `rdfs:subPropertyOf` between object properties | compiled | relationship `extends`; the parent is `abstract` | `LABEL <parent> NO PROPERTIES` on each sub-relationship's edge table; no edge table for the parent |
| `owl:equivalentClass` definition (defined class), with its restrictions | compiled | defined entity (`definition`) | the boolean property `is<Class>` on the base's node table, computed from the definition; `kcmd test` checks it (`defined-membership`) |
| `owl:NamedIndividual` whose code a definition uses | compiled | the code inside the definition | inside the `is<Class>` expression |
| `owl:Restriction`, `owl:FunctionalProperty` on an object property, `owl:disjointWith`, `owl:AllDisjointClasses` | compiled | constraint, or the model structure | — not deployed¹³; `kcmd validate` counts the violations in the bound tables |
| SHACL node and property shapes and their constraint components | compiled | constraint, or the model structure | — not deployed¹³; `kcmd validate` counts the violations |
| `sh:message` or `sh:description`, `sh:severity` | compiled with their constraint | constraint `description`, `severity`, `on_violation` | — not deployed¹³ |
| `owl:TransitiveProperty` | hinted | relationship `ai_context.instructions` | into the edge's `OPTIONS(description)`; a query follows the edge with a quantified path `-[:p]->{1,k}`, which `kcmd test` checks (`transitive-closure`) |
| `owl:SymmetricProperty` | hinted | relationship `ai_context.instructions` | into the edge's `OPTIONS(description)`; a query matches the edge undirected |
| `owl:equivalentClass` or `owl:equivalentProperty` to a named term | hinted | `ai_context.synonyms` | `OPTIONS(synonyms=[...])` |
| `owl:deprecated`, with an `rdfs:seeAlso` replacement | hinted | `DEPRECATED:` description prefix and `ai_context.instructions` | into `OPTIONS(description)` |
| `rdfs:label`, `skos:altLabel`, `rdfs:comment`, `skos:example` | compiled | `description`, field `label`, `ai_context.synonyms`, `instructions` or `examples` | `OPTIONS(description)` and `OPTIONS(synonyms=[...])` (see [To BigQuery](#to-bigquery)) |
| `owl:Ontology` header and its `owl:versionInfo` | compiled | model `description` and `ai_context` | — dropped⁸ |
| `skos:Concept` | compiled | glossary term | — not deployed¹⁶ |
| `owl:propertyChainAxiom`, `owl:oneOf`, other named individuals, `owl:AllDifferent`, `owl:propertyDisjointWith`, `owl:AllDisjointProperties`, reflexive, irreflexive and asymmetric properties, `rdfs:subPropertyOf` between datatype properties, `rdfs:isDefinedBy`, a term's `owl:versionInfo`, other `rdfs:seeAlso` | dropped | — | — |
| SHACL `sh:name`, targets other than `sh:targetClass`, nested and logical shapes, deactivated shapes | dropped | — | — |

The outcome and the lowering answer different questions. A construct is
compiled when the model holds it natively, even where the graph then leaves it
out: a constraint is compiled, and `kcmd validate` measures it, but no graph
carries it. A hinted construct reaches the graph only as text an agent reads.
A Spanner target keeps the structural lowerings and drops every `OPTIONS` (see
[To Spanner](#to-spanner)).

### The coverage file

An import writes its report into `coverage.json` beside the model document it
wrote, or to the file `--coverage <path>` names. The file holds the reports of
every model imported there, keyed by model and then by importer. Trimmed to one
construct:

```json
{
  "coverage_version": 1,
  "models": {
    "shop": {
      "owl": {
        "importer": "owl",
        "model": "shop",
        "sources": ["shop.ttl"],
        "summary": [
          {"construct": "rdfs:subClassOf", "compiled": 1, "hinted": 0, "dropped": 0}
        ],
        "totals": {"compiled": 1, "hinted": 0, "dropped": 0},
        "entries": [
          {"construct": "rdfs:subClassOf", "subject": "Customer SubClassOf Party",
           "outcome": "compiled", "target": "entity Customer extends"}
        ]
      }
    }
  }
}
```

A SHACL import of the same model adds a `shacl` report, of the same shape,
beside `owl`.

| Key | Holds |
|---|---|
| `importer` | `owl` or `shacl`. |
| `model` | The model the import wrote. |
| `sources` | The files read, as given on the command line. |
| `summary[]` | One row per construct, in the order the importer reports them: `construct`, `compiled`, `hinted`, `dropped`. It is the table the import prints. |
| `totals` | `compiled`, `hinted` and `dropped` over all rows. |
| `entries[]` | One per occurrence: `construct` (its vocabulary term, such as `rdfs:subClassOf` or `sh:minCount`); `subject` (the occurrence, readable on its own, such as `Order SubClassOf Document` or `OrderShape / total on Order`); `outcome`; `target` (where a compiled or hinted occurrence landed, such as `entity Order extends` or `constraint Order_total_required`); and `reason` (why it was hinted or dropped, or how it compiled when the target does not say). |
| `pruned` | OWL only, after `--prune-unbound`: the removed `entities`, `relationships` and `constraints`. |

Writing a report replaces only the report of the same importer for the same
model, so an OWL import followed by a SHACL import leaves both side by side. A
file that is not a coverage file, or that cannot be read, is replaced. Model
documents are `*.yaml`, so no push or pull reads the file.

## To Knowledge Catalog

The catalog holds metadata rather than a full copy of your model. Every resource
type it uses is a built-in system type under `dataplex-types/global`, apart from
the custom `semantic-action` and `semantic-constraint` pairs and the three
aspect-only annotation types (`semantic-ai-context`, `semantic-expressions`,
`semantic-binding`) that `kcmd init` provisions. A push references those types
and never creates them (see
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
relationship that carries no join columns is skipped with a warning.

**One binding, not all of them.** A model may define several physical
realizations — an analytical binding onto BigQuery and an operational one onto
Spanner, say — and `kcmd push --all-profiles` deploys a graph for each. The
catalog leg does not fan out with it: it runs once, against the profile named by
`--profile`, otherwise the default binding. So a bare `kcmd push` and a
`kcmd push --all-profiles` write the same entries and differ only in how many
graphs they deploy.

Nor do successive pushes accumulate. Entry ids are derived from logical names
alone — model, entity, metric — with no profile component, so pushing a second
profile reconciles the catalog to *that* binding rather than adding to what the
first one wrote: shared elements have their `source` swapped to the new profile's
tables, and — on a push that deploys a graph, and so prunes — an entity or metric
the new binding cannot answer is deleted rather than left behind. The catalog
therefore describes one physical realization at a time. It records that binding's
deployment target and tables, but never the profile's name, and never that the
other profiles exist. A `pull` returns whichever was written last. Keep the
profile files — the catalog is not their store.

**Lossless when the annotation aspects are provisioned.** The published
system-type templates do not carry a per-field `semantics` block, a
`semantic-metric.expression` field, synonyms, examples, field-level
`ai_context`, the original vendor SQL (`importedExpression`), hydration rules
or vocabulary members. When `kcmd init --semantic-model` has provisioned the
`semantic-ai-context`, `semantic-expressions` and `semantic-binding` aspect
types, a push stores all of that on them — expressions included, with no flag
— and `pull` restores it, so a push→pull of the same model is a fixed point
(see footnote ²⁰ under the matrix). On a catalog without those types, the old
behavior applies: the default push omits the expressions (pass
`--emit-expressions` to write the canonical GoogleSQL/ANSI expression into the
built-in fields), and synonyms, examples, field-level `ai_context` and vendor
SQL are not stored — only model, entity, and metric `instructions` have a home,
in the `guidelines` aspect. Either way the authored document stays the source
of truth for graph SQL.

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
most for a many-to-many relationship: a catalog pushed before junction entries
existed holds the foreign-key `schema-join` links only, so a concept naming an
M:N edge would look unresolvable on a model that is perfectly well-formed. It
comes back untouched instead. (A current push publishes the M:N edge as a
junction entry, and pull recovers it.²⁰)

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
into Knowledge Catalog instead. Unique keys beyond the primary key are also
dropped (only the primary key is emitted). The imported vendor SQL is not carried
as a separate form: the graph builds from the canonical `expression` when
present, and falls back to the imported vendor SQL verbatim only when the model
was never transpiled to a canonical form.

**Generated views (proposed).** A model with vocabularies or derived
relationships deploys more than the graph. Before `CREATE OR REPLACE PROPERTY
GRAPH`, the push runs one `CREATE OR REPLACE VIEW` for each of these, in this
order:
- each vocabulary view, `vocab_<entity>`;
- each view behind an edge into a vocabulary, `edge_<relationship>`;
- each derived-relationship view, `edge_<relationship>`.

A view whose source the model names goes there; otherwise it goes in the
graph's dataset. The views only read the model's tables. A failing view stops
the push before the graph. `--print` lists them with the graph DDL. Each
view's own `OPTIONS(description)` says what it holds and that kcmd generated
it. See footnotes ¹⁷ and ¹⁸.

### Metric graphs for `GRAPH_EXPAND` (proposed)

> [!NOTE]
> A proposed kcmd enhancement. It changes what a push deploys, not the model
> spec; `kcmd push --no-metric-graphs` turns it off.

`GRAPH_EXPAND` is how a graph `MEASURE` is read without an Enterprise
reservation (GQL needs one). It accepts only a tree: at most 10 node tables, one
root, every other node reached by exactly one path, and measures on labels no
other table shares. A main graph rarely qualifies — it holds every entity,
several facts, inverse edges and diamonds — so next to each main graph a
BigQuery push also deploys one **metric graph per fact entity** (the entity a
metric aggregates), named `<graph>__<fact_in_snake_case>_metrics`:

- **The tree.** The fact is the root. The entities the fact's metrics read are
  reached first, along many-to-one relationships (a foreign key onto the
  destination's primary or a unique key): shortest path, relationships taken in
  name order. The tree then grows breadth-first with further many-to-one
  dimensions of the fact, each reached once, until it has 10 node tables.
  Inverse edges, many-to-many and self relationships, and a second path to a
  node already reached are left out; `--dry-run` lists what each graph leaves
  out.
- **Labels.** The ancestors of the kept entities become labels only (a concrete
  ancestor outside the tree is made table-less), so label reads keep working.
  The super-relationships of kept edges stay edge labels.
- **Measures.** Only the fact's metrics are carried. A single-aggregate metric
  is one `MEASURE`. A composite metric — a formula over several aggregates, such
  as `100 * SUM(a) / (SUM(a) + SUM(b))` — becomes one single-aggregate measure
  per component (named after a simple metric with the same aggregate, else
  `<metric>__agg<N>`) plus a composition over `AGG()` of each:
  `100 * SAFE_DIVIDE(AGG(T_a), AGG(T_a) + AGG(T_<metric>__agg2))`. Each `/`
  becomes `SAFE_DIVIDE`, and a multiplier stays outside it. `COUNTIF(cond)` is
  rewritten as `SUM(CAST(is<Defined> AS INT64))` when `cond` is the membership
  predicate of a defined entity of that table (its membership property), and
  otherwise as `SUM(CASE WHEN cond THEN 1 ELSE 0 END)`. `COUNT(*)` counts the
  rows of the entity the other aggregates read (else the metric's entity). A
  component that reads another entity is declared on that entity's node table
  and aggregates the rows the root reaches.
- **Already served.** A fact whose tree would be the whole main graph, with
  every metric already a `MEASURE` there, gets no metric graph: the main graph
  serves `GRAPH_EXPAND` itself.
- **Fallback view.** Some metrics fit no tree: the entities their aggregates
  read are not reachable from one of them through many-to-one relationships, a
  path converges, they need more than 10 node tables, or they use an aggregate
  that cannot be a `MEASURE` (such as `STDDEV`). Such a metric falls back to a
  generated SQL view, `<graph>__<fact>_metrics_view`: one row per fact record,
  with the dimensions LEFT JOINed along the same tree and columns named
  `<Entity>_<field>` as in `GRAPH_EXPAND` output. Each fallback is a push
  warning. Two kinds of metric get neither a graph nor a view, and the query
  skill gives plain SQL for them:
  - a metric a flat view would compute wrong (a duplicate-sensitive aggregate
    over a dimension's rows);
  - a metric that reads a defined entity, which has no table (a `MEASURE`
    cannot filter rows).

The main graph is unchanged. Metric graphs and views are derived, not authored:
Knowledge Catalog does not record them, `pull` does not read them, and every
push regenerates them. The query skill names, for each metric, the graph to read
and the expression to select (see
[Agent skills](skills.md#metrics-and-metric-graphs-proposed)).

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

**Actions and constraints** reach neither graph. They are published to
Knowledge Catalog as one `semantic-action` or `semantic-constraint` entry each
and round-trip losslessly through `pull` — see
[To Knowledge Catalog](#to-knowledge-catalog).

## What pull recovers

`pull` returns what push wrote — the **Recovered by `pull`** column above is the
summary. When the push deployed a graph, what push wrote was already pruned to
the bound view (see [To Knowledge Catalog](#to-knowledge-catalog)), so pull
returns that view. Two things about *how* it comes back:

**Normalized** — the content survives, the form changes. With the annotation
aspects provisioned (footnote ²⁰), the first three items below do not apply:
names, types and dimension roles come back as authored.

- Relationship *names* come back lowercased/hyphenated (`Places Order` →
  `places-order`); without `semantic-ai-context` the catalog stores the name
  only in the link id. See [Writer-side follow-up](#writer-side-follow-up).
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

## Writer-side follow-up

One reduction above is a limit of what push currently *writes* to the built-in
types rather than of what pull can recover. It is recorded here as a write-side
follow-up; the reader (pull) already returns everything the catalog holds.

- **Relationship names.** The `schema-join` aspect type's `metadataTemplate` has
  no field for the relationship name, and an entry link cannot carry a custom
  aspect. kcmd therefore stores the authored name in the relationship index of
  the model entry's `semantic-ai-context` aspect when that type is provisioned;
  otherwise pull recovers it from the link id — which is lowercased and
  hyphenated (the entry-link id format forbids the original
  casing/underscores). A name field on the built-in `schema-join` aspect type
  (server-side) would make the custom carrier unnecessary; it is the same class
  of gap as the `semantics` field that gates `--emit-expressions`.

(A non-canonical deployment target is **not** a pull gap: push rejects it at the
validation gate before any leg runs, so it is never written — see
[Validation](reference.md#validation).)
