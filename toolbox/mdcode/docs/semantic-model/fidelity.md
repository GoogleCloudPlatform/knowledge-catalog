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

A model imported from an OWL ontology or SHACL shapes has already lost
something before any push. [What an import keeps](#what-an-import-keeps-proposed)
follows each imported construct through the import's coverage report and on to
what it becomes in a BigQuery graph.

## The round-trip matrix

Rows are what you authored; columns are its fate in each direction. `✓` = comes
back as authored; `—` = not present in that destination. Footnotes carry the
nuances that don't fit a cell. BigQuery and Spanner each get a column; they
agree on every structural row and differ only where a Spanner target has no
`MEASURE` and no `OPTIONS` metadata, and in which SQL text a field reads — see
[To Spanner](#to-spanner).

| Authored element                                               | → Knowledge Catalog             | Recovered by `pull`                            | → BigQuery                                                           | → Spanner                                                            |
|----------------------------------------------------------------|---------------------------------|------------------------------------------------|----------------------------------------------------------------------|----------------------------------------------------------------------|
| Entity (name, `source`)                                        | `semantic-entity` entry¹⁰       | ✓                                              | generated node view + `NODE TABLE` over it¹⁹                         | `NODE TABLE`                                                         |
| Field                                                          | `schema` aspect field           | ✓ (type²)                                      | column on the node table¹                                            | column on the node table¹                                            |
| Field `label`                                                  | `schema` per-field annotation   | ✓                                              | into `OPTIONS(description)`                                          | — dropped                                                            |
| Field expression (canonical SQL)                               | `sql-expressions` aspect³       | ✓³                                             | builds the DDL                                                       | builds the DDL                                                       |
| Field dimension role (`is_time`)                               | `schema` per-field `semantic`³  | ✓³                                             | noted in `OPTIONS(description)`                                      | — dropped                                                            |
| Primary key                                                    | `semantic-entity.primaryKey`    | ✓                                              | `KEY(...)` on the node table                                         | `KEY(...)` on the node table                                         |
| Unique keys                                                    | `semantic-entity.uniqueConstraints` | ✓                                              | — dropped                                                            | — dropped                                                            |
| Metric                                                         | `semantic-metric` entry         | ✓ (type⁵)                                      | `MEASURE`⁴                                                           | — dropped (no `MEASURE`)                                             |
| Relationship (1:1 / 1:N)                                       | `semantic-relationship` entry¹⁵ | ✓⁶                                             | `EDGE TABLE`                                                         | `EDGE TABLE`                                                         |
| Relationship (M:N / `association`)                             | — not stored                    | —                                              | `EDGE TABLE` (via junction table)                                    | `EDGE TABLE` (via junction table)                                    |
| Entity `extends`                                               | `semantic-entity.extends`       | ✓                                              | `LABEL` clauses + flattened fields                                   | `LABEL` clauses + flattened fields                                   |
| Entity `abstract`                                              | table-less `semantic-entity` entry + `Abstract:` paragraph | ✓                      | — no node table (a label on its subtypes)                            | — no node table (a label on its subtypes)                            |
| Field `unit` / `scale`                                         | `Unit: USD (x1000).` trailer on the `schema` field description | ✓ (trailer peeled off) | into column `OPTIONS(description)`                              | — dropped                                                            |
| Entity `grain` / `history`                                     | `Grain:` / `History:` paragraphs on the entry description | ✓ (paragraphs peeled off) | into node label `OPTIONS(description)`; the node table stays the all-versions table | — dropped                                    |
| Entity `members` (vocabulary, proposed)                        | `Members:` paragraph on the entry description¹⁷ | ✓ (codes and labels¹⁷)         | generated `vocab_<entity>` view + `NODE TABLE` over it; edges into it via generated views¹⁷ | — push error without a `source`¹⁷ |
| Relationship `via` / `filter` (derived, proposed)              | `semantic-relationship` entry + `Derived via:` / `Derived filter:` paragraphs¹⁸ | ✓¹⁸ | generated `edge_<relationship>` view + `EDGE TABLE` over it¹⁸ | — push error¹⁸ |
| Entity `hydration` / `mode` (binding)                          | `Hydration:` paragraph¹⁹; grounding links to `@bigquery` node view / table entries¹⁹ | ✓¹⁹ | the generated node view's rows (`mode: direct`: the source table as-is)¹⁹ | — tables bound as-is; `derive_from` is a push error¹⁹ |
| Action                                                         | `semantic-action` entry¹²       | ✓¹²                                            | — not deployed¹²                                                     | — not deployed¹²                                                     |
| Constraint                                                     | `semantic-constraint` entry¹³; `Constraints:` paragraph on an enforcing entity¹³ | ✓¹³ (paragraph peeled off) | applied by the node view under `hydration.constraints: enforce`¹³ | — not deployed¹³                                                     |
| Glossary (`glossary:`)                                         | Business Glossary, categories, terms and `related` / `definition` entry links, via `kcmd glossary push`¹⁶ | — not yet¹⁶ | — not deployed¹⁶ | — not deployed¹⁶ |
| `description` (entity / metric / field / relationship)         | entry description / `schema`    | ✓                                              | `OPTIONS(description)`                                               | — dropped                                                            |
| `ai_context.synonyms`                                          | `semantic-*` aspect / `schema`  | ✓                                              | `OPTIONS(synonyms=[...])`                                            | — dropped                                                            |
| `ai_context.instructions`                                      | `guidelines` aspect⁷            | ✓⁷                                             | `OPTIONS(extensions=[("instructions", ...)])`                        | — dropped                                                            |
| `ai_context.examples`                                          | `overview` aspect               | ✓                                              | `OPTIONS(extensions=[("examples", ...)])`                            | — dropped                                                            |
| Model-level `description` / `instructions`                     | on the model entry              | ✓⁸                                             | — dropped⁸                                                           | — dropped⁸                                                           |
| Model-level `ai_context.synonyms` / `examples`                 | `semantic-model` / `overview`   | ✓                                              | — dropped                                                            | — dropped                                                            |
| `deployments` (`name`, `target`, `profile`)                    | recorded on the model entry     | ✓                                              | names the graph                                                      | names the graph                                                      |
| Binding profile (`<model>.profile.<name>.yaml`)                | on the model's entries¹⁴        | ✓¹⁴                                            | one graph per BigQuery deployment                                    | one graph per Spanner deployment                                     |
| Vendor-dialect `expression` variant (non-canonical `dialects[]` entry)¹¹ | `sql-expressions` aspect | ✓                                              | — not used; a field or metric with only vendor text is left out     | — not used; a field with only vendor text is left out               |
| `custom_extensions` from a vendor other than GOOGLE            | `semantic-extensions` aspect⁹   | ✓⁹                                             | — not in graph                                                       | — not in graph                                                       |

1. **Field type source.** The graph uses the source column's own type; a
   field's authored `datatype` is not carried.
2. **Field type.** Every concrete type round-trips. Push stores a field with
   no `datatype` as `dataType` `Opaque`, and `pull` writes no `datatype` for an
   `Opaque` field, so a field typed `Opaque` comes back untyped.
3. **Expressions and dimension role.** Push stores each field's expression in
   its entity's `sql-expressions` aspect, and its dimension role and `is_time`
   in the `schema` aspect, and `pull` rebuilds both from there.
4. **Metric shape.** A metric must resolve to exactly one entity, or the push
   is rejected. It must also read every field inside `SUM`, `AVG`, `COUNT`,
   `MIN` or `MAX`, each over one operand, and scalar SQL may combine them, as
   in `SUM(orders.amount) / COUNT(orders.order_id)`. Otherwise the push is
   rejected. The metric graphs deployed next to the main graph (proposed) also
   serve multi-entity metrics across many-to-one trees — see
   [Metric graphs for `GRAPH_EXPAND`](#metric-graphs-for-graph_expand-proposed).
5. **Metric type.** A metric's data type round-trips as a field's does (see
   footnote 2): an untyped or `Opaque` metric comes back untyped.
6. **Relationship name.** A relationship's name is the last segment of its
   entry id, `<model>/relationships/<relationship>`, so it comes back as
   written.
7. **Guidelines aspect.** The `guidelines` aspect holds the
   `ai_context.instructions` and the custom `ai_context` members of the model,
   an entity, a field, a metric or a relationship. A field's `guidelines`
   aspect sits on its entity's entry at `Schema.<field>`. Push leaves out a
   custom member whose value Knowledge Catalog cannot store as written, such as
   `.inf`, and warns.
8. **Model-level metadata.** Neither graph has a home for statement-level
   metadata — BigQuery silently drops graph-statement `OPTIONS`, and Spanner
   carries no `OPTIONS` at all — so the model's `description` and
   `ai_context.instructions` are carried into Knowledge Catalog instead.
9. **Other custom extensions.** A `custom_extensions` block from a vendor other
   than GOOGLE goes, as written, into the `semantic-extensions` aspect of the
   model, entity, field, metric or relationship that declares it, and `pull`
   writes it back. The graphs leave it out.
   The OWL importer emits none:
   it is import-only (see [Importing an OWL ontology](owl-import.md)).
10. **Logical (unbound) model.** A model with no bindings still publishes to
    Knowledge Catalog. An entity with no `source` gets an entry whose
    `semantic-entity` aspect records no source, and a relationship with no join
    columns still gets its entry and its links.
11. **Vendor-dialect fallback.** What you author is the `expression.dialects[]`
    list using one of the supported SQL dialects (see
    [Model spec §2.5](model_spec.md#25-expressions)).
    `importedExpression` / `importedDialect` are not
    authored keys — the loader *derives* them from a non-canonical dialect entry
    (for example the `SNOWFLAKE` or `DATABRICKS` form a metric was imported
    from). `kcmd import
    --transpile` adds a `BIGQUERY` dialect entry to a model file's field or
    metric, translated from a vendor-only expression or from an `ANSI_SQL`
    expression that double-quotes column names, when it can translate the
    text. It does the same in each
    profile the import writes, when all of that profile's tables are in
    BigQuery or BigLake. Without the translation, kcmd warns about
    either kind of text on a BigQuery table. Spanner, MySQL and Databricks
    also read a double-quoted name as text, so kcmd warns about that kind on
    their tables, apart from a Spanner table in a PostgreSQL-dialect database,
    which push, `kcmd profiles` and import judge as `POSTGRES` once they read
    its database's dialect.
    On a table in another database, it warns about a field or metric with no
    text that table runs. Push rejects such a field in the model file with an
    error in place of the warning. `kcmd import` gives push's message in place
    of the warning on an AlloyDB table, and on a Cloud SQL, Spanner or
    third-party table whose dialect it reads as push does. When a profile binds
    that table, push rejects the field or metric instead. When import cannot
    read a table's dialect, it warns and skips the checks that need it.
    `kcmd skills-generate` and `kcmd profiles --print-store` do not look up a
    third-party table's dialect for their warnings, and they read a Spanner
    table as `SPANNER`. The check `--print-store` runs on the named profiles
    reads each table's dialect as push does.
    Import reads a Cloud SQL table it cannot look up as MySQL when the name has
    no schema. On any
    other table whose dialect a command has not looked up, kcmd warns only about
    a field or metric with no text in any dialect the table's name allows. A
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
13. **Constraints.** A constraint is published to Knowledge Catalog as one
    `semantic-constraint` entry under the model entry, and `pull` reads it back.
    No graph has a construct for one. On BigQuery, an entity whose binding sets
    `hydration.constraints: enforce` has its node view apply every rule `kcmd
    validate` can check (a `reject` rule's failing value withheld, or the row
    left out for a required field or the key; every broken rule named in
    `_warnings`), and its entry carries a derived `Constraints:` paragraph with
    how often each rule breaks, which `pull` drops (see
    [Enforcing constraints at consumption time](validation.md#enforcing-constraints-at-consumption-time)).
    Spanner deploys nothing for a constraint and warns once. What settles a
    judged rule is a run: the runtime an application embeds puts each guard to a
    judge before the write.
14. **Binding profiles and deployments.** A model may define several physical
    realizations in sibling `<model>.profile.<name>.yaml` files and reference
    them from `deployments` (see [Binding profiles](profiles.md) and
    [Reference → push](reference.md#push)); two deployments claiming the same
    target are rejected before anything deploys. Push records each named
    profile and what it binds on the model's entries, and `pull` rebuilds one
    profile file per named profile from them. The catalog stores no profile's
    actions, so a pulled profile file keeps the actions the local one binds.
15. **Relationship entries and links.** Each relationship gets its own entry.
    A `semantic-link` joins each ordered pair of related entities and lists
    their relationships in declaration order, so several relationships between
    the same two entities share one. A `reference` link runs from each
    relationship's entry to each of its two entities. Pull reads each
    relationship from its entry and reads no link.
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
    entity has no node view, so its refusal is reported. A reader
    (`glossaryFromDataplex`) peels
    the trailers off again, but `kcmd pull` does not call it yet. The OSI
    export carries the block as is. See [Business glossary](glossary.md).
17. **Vocabulary members (proposed).** Neither entity template has a
    slot for a member list, so a vocabulary's entry description ends with a
    `Members: "OPEN" — "Open"; "VOID" — "Cancelled".` paragraph (codes and
    labels as JSON strings, `Members: none.` for an empty list). Pull peels it
    off and restores `members` with codes and labels in paragraph order.
    Publishing members as Business Glossary terms is a follow-up. On
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
    its `semantic-relationship` entry with `Derived via: ^memberOf, inClub.` at
    the end of its description, plus `Derived filter: <expression>` when it has
    a filter. Pull peels both off, restoring `via` and `filter`. On BigQuery,
    kcmd generates the view `edge_<snake_case(relationship)>`. It holds the
    distinct (`source_<key>`, `target_<key>`) pairs the chain reaches, and the
    edge table reads it. Some chains cannot be materialized, and the edge is
    then omitted with a warning:
    - a step through a junction or column-less edge;
    - an endpoint with no table;
    - a step that is itself derived with its own `filter`.

    Spanner rejects a derived relationship at push time. See
    [Extensions](model_spec.md#5-extensions).
19. **Hydration and binding mode.** An entity with `hydration` rules or
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
    [Node views](reference.md#node-views-hydration)), and push adds grounding
    links to the `@bigquery` entries of the generated node views and tables in
    the same region; a `derive_from` entity publishes a table-less entry.
    Spanner binds tables as-is and rejects `derive_from` at push time.

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
| `owl:Class` with no key (own or inherited) and subclasses (`owl:hasKey (absent)`), or `kcmd:abstract true` | compiled | entity `abstract: true`, with no keys of its own: its unique keys, and the primary key of a class `kcmd:abstract` makes abstract, move to its concrete subclasses | no node table; a `LABEL` on its subtypes' node tables |
| keyless leaf `owl:Class` (`owl:hasKey (absent)`) | dropped (reported) | entity with no `primary_key` | no node table until the model gives it a key |
| `owl:equivalentClass` from an unkeyed class to a keyed one (`owl:equivalentClass (folded)`) | compiled | the keyed entity: relationships, fields and `extends` re-pointed, names as `ai_context.synonyms` | the keyed entity's node table and `OPTIONS(synonyms=[...])` |
| `rdfs:subClassOf` (named class) | compiled | entity `extends` | `LABEL` clauses on the subtype's node table, inherited fields flattened down |
| `rdfs:subClassOf` from a vocabulary to a class with fields | dropped | — (the vocabulary has no `extends` to it) | — |
| `owl:hasKey` | compiled | `primary_key`; on a class `kcmd:abstract true` makes abstract, the primary key or a unique key of its concrete subclasses | `KEY(...)` on the node table |
| `owl:InverseFunctionalProperty` | compiled | `unique_keys` (inherited by concrete subclasses, and kept only there when its class is abstract), or `primary_key` on a keyless class with no keyed subclass | — dropped (only the primary key is emitted), unless it became the primary key |
| `owl:DatatypeProperty` and its `rdfs:range` | compiled | field and its `datatype` | a property of the node table, typed by the bound column¹ |
| `owl:unionOf` as an `rdfs:domain` | compiled | the field on every member class | a property of each member's node table |
| `owl:FunctionalProperty` on a datatype property | compiled (by construction) | a field, which holds one value | a property, which holds one value |
| `qudt:unit` and the other unit annotations | compiled | field `unit` | a `Unit:` trailer in the property's `OPTIONS(description)` |
| `owl:ObjectProperty` | compiled | relationship | `EDGE TABLE` once the model gives it join columns and both ends are node tables |
| `owl:ObjectProperty` whose `rdfs:domain` or `rdfs:range` is an abstract class | compiled | relationship `abstract: true`, with no join columns; a derived one keeps its chain as text in `ai_context.instructions` | no edge table; a label on the edge tables of the relationships that extend it |
| `encodedBy` on an object property | compiled | relationship `from_columns` / `to_columns` (the destination's single-column key, own or inherited); dropped, with a warning, when the relationship is abstract | the `EDGE TABLE`'s `SOURCE KEY` / `DESTINATION KEY` |
| `kcmd:Metric` individual | compiled | metric (`expression`, `description` with `Unit:`, `ai_context`); a glossary term when the model has a glossary | `MEASURE`⁴ |
| `owl:inverseOf` | compiled | relationship `inverse` | a second `EDGE TABLE` over the same backing table, `SOURCE` and `DESTINATION` swapped, no `OPTIONS` |
| `rdfs:subPropertyOf` between object properties | compiled | relationship `extends`; the parent is `abstract` | `LABEL <parent> NO PROPERTIES` on each sub-relationship's edge table; no edge table for the parent |
| `owl:equivalentClass` definition (defined class), with its restrictions | compiled | defined entity (`definition`) | the boolean property `is<Class>` on the base's node table, computed from the definition; `kcmd test` checks it (`defined-membership`) |
| `owl:NamedIndividual` whose code a definition uses | compiled | the code inside the definition | inside the `is<Class>` expression |
| `owl:Restriction`, `owl:FunctionalProperty` on an object property, `owl:disjointWith`, `owl:AllDisjointClasses` | compiled | constraint, or the model structure | not in the graph¹³; `kcmd validate` counts the violations in the bound tables; an enforcing node view applies a restriction on a field and reports the rest |
| SHACL node and property shapes and their constraint components | compiled | constraint, or the model structure | not in the graph¹³; `kcmd validate` counts the violations; an enforcing node view applies the field rules (withhold / exclude / flag in `_warnings`) and reports the relationship rules |
| `sh:message` or `sh:description`, `sh:severity` | compiled with their constraint | constraint `description`, `severity`, `on_violation` | `on_violation` decides what an enforcing node view does¹³ |
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
out: a constraint is compiled, `kcmd validate` measures it, and an enforcing
node view applies it, but no graph construct carries it. A hinted construct reaches the graph only as text an agent reads.
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

The catalog holds the model's metadata. Every resource type it uses is a
built-in system type under `dataplex-types/global`, apart from the custom
`semantic-action` and `semantic-constraint` pairs that `kcmd init`
provisions. A push references those types and never creates them (see
[Reference → What gets created in Knowledge Catalog](reference.md#what-gets-created-in-knowledge-catalog)).

Every push publishes the model file as written to Knowledge Catalog: every
entity, metric, and relationship the document declares, apart from a
many-to-many association, which has no entry yet. A `pull` rebuilds the model
and profile files from that metadata alone, and changes a local file only
where it differs (see [What pull recovers](#what-pull-recovers)).

A logical model still produces complete entries (footnote 10).

**Model file and sibling profile files.** A model may define several physical
realizations — an analytical binding onto BigQuery (`<model>.profile.analytical.yaml`)
and an operational one onto Spanner (`<model>.profile.operational.yaml`), say —
and list both in `deployments`. Push records each named profile in the catalog
metadata, and `pull` rebuilds the profile files from it (footnote 14; see
[Reference → push](reference.md#push)).

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
A projection whose field is not in the pulled document comes back as a
declared parameter carrying the resolved `type` instead, since emitting a
`concept`/`field` pair that resolves to nothing would write a document that will
not load. A `sql` executor
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
pull recovers each relationship from its own entry, and a many-to-many
relationship has none, so a concept naming an M:N edge would look unresolvable
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

BigQuery's graph `OPTIONS` give an element a `description` string, a `synonyms`
array, and an `extensions` array of `(key, value)` string pairs. `synonyms`
carries across structurally as `synonyms=[...]`. `ai_context.instructions` and
`ai_context.examples` carry across in `extensions=[...]` as
`("instructions", "...")` and `("examples", "[...]")`, with `examples`
serialized as a JSON array string. Custom `ai_context` members stay out of the
DDL. A field's `label` and temporal-dimension marker have no dedicated option,
so they still combine with the field's `description` in `OPTIONS(description)`.

The model's own statement-level metadata has nowhere to go: BigQuery silently
drops graph-statement `OPTIONS`, so the model's `description` / `ai_context` are
not in the graph — the `description` and `ai_context.instructions` are carried
into Knowledge Catalog instead. Of an entity's keys only its primary key is
emitted as `KEY(...)`; `unique_keys` are dropped. The imported vendor SQL is
never emitted. `kcmd import --transpile` adds a `BIGQUERY` entry to a model
file's field or metric whose expression is vendor-only or an `ANSI_SQL`
expression that double-quotes column names, when it can translate the text. It
does the same in each profile the import writes, when all of that profile's
tables are in BigQuery or BigLake.
The graph builds each field and metric from its `BIGQUERY` entry, else its
`ANSI_SQL` one. A field with none of these is left out of its node table with a warning,
though push rejects such a field in the model file first. A
metric with none, or one that aggregates such a field, is skipped with a
warning.

### What import translates to BigQuery

`kcmd import --transpile` sees only the SQL text. So it translates only common
SQL that gives the same value in BigQuery for ordinary data, whatever the
column types are. It translates aggregates, CASE, COALESCE and other NULL
handling, arithmetic beside a number or a SUM, COUNT or AVG, most comparisons,
basic casts, and a few string and date functions. Its warning about any other
text names the first part it does not translate.

BigQuery rejects a translated field when a column's BigQuery type is not the
one the expression needs, such as a DATETIME column compared with the current
time. Then edit that field's `BIGQUERY` entry.

The BigQuery value can differ from the source's value in these cases:

- A decimal, boolean or timestamp column joined into text takes BigQuery's
  text format, such as '12.5' for 12.50.
- A MySQL date column plus a number gives a date in BigQuery where MySQL gives
  a number.
- MySQL, SQL Server and PostgreSQL compare text by a collation. Text that
  differs only in letter case, accents or trailing spaces can give another
  value. PostgreSQL also ignores spaces and punctuation when it sorts text.
- A Snowflake or Databricks division or average can differ after the sixth
  decimal place.
- On a Snowflake FLOAT or PostgreSQL double precision column, an average or a
  Snowflake division can differ slightly from the source's. FLOOR or CEIL of it
  can then differ by one at a whole number, and a comparison of it can give the
  other result.

Spanner's default time zone, America/Los_Angeles, is written into the date and
time functions of a `SPANNER` text. Snowflake's default time zone is written
into the current date and time functions of a `SNOWFLAKE` text.

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
  warning. Two kinds of metric get neither a graph nor a view, and are read with
  plain SQL over the bound tables:
  - a metric a flat view would compute wrong (a duplicate-sensitive aggregate
    over a dimension's rows);
  - a metric that reads a defined entity, which has no table (a `MEASURE`
    cannot filter rows).

The main graph is unchanged. Metric graphs and views are derived, not authored:
Knowledge Catalog does not record them, `pull` does not read them, and every
push regenerates them.

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
[To Knowledge Catalog](#to-knowledge-catalog). On BigQuery, a node view under
`hydration.constraints: enforce` applies the constraints to the rows it serves;
a Spanner graph binds tables directly and applies none.

## What pull recovers

`pull` rebuilds the model file from the catalog metadata that the rest of this
section describes. It changes a local model or profile file only where its
content differs from the catalog's: pull compares the file it would write for
the local file with the one it writes for the catalog, so a difference that is
only one of the normal forms below changes nothing. Each value the catalog holds
as the file says keeps its text, comments, key order and formatting, and a file
that holds what the catalog holds stays byte for byte. A changed string keeps
its quoting or block style, and other changed values are written in pull's form.
When the catalog reorders a list whose order counts, such as an entity's fields,
an item that moves, or an item it moves past, can be written in pull's form too.
Pull writes a file whole, with none of its comments, key order or formatting,
when there is no local file, when the local file does not load or is not valid
UTF-8, and when changing only those values would not give what the catalog
holds.
[Pull](README.md#pull) says when `pull` refuses the catalog instead.

Pull reads the second-generation types. It rebuilds the model file, profile
files and overview sidecars from the metadata. A model file it writes whole
states each metric's entity as `entity:`, declared or derived. See
[Reference](reference.md#the-second-generation-types). A model an older
`kcmd` pushed with the first-generation types is left out with a warning.

`pull` returns what push wrote: the model and every named profile. Push does
not prune the model to a deployment's profile first.

**Normalized** — the content survives, the form changes:

- A field or metric typed `Opaque` comes back with no `datatype`, since push
  stores one with no type as `Opaque` too.
- `ai_context` comes back in the object form, and its custom members come
  back sorted by name.
- A profile's `metrics_exclude` comes back as `"*"` when it excludes every
  metric, and otherwise as a list in name order.
- Entities, relationships, metrics, actions and constraints come back sorted
  by name. Field order within each entity is kept.

**So a file pull writes whole is not your original file.** Treat a rebuilt
document as a faithful copy of the catalog metadata rather than of the authored
model, and keep the authored document as the source of truth.

(A deployment target in no supported form is **not** a pull gap. Every push
rejects it at the validation gate before anything is written, a catalog-only
push (`--no-deployment`) too; see [Validation](reference.md#validation).)
