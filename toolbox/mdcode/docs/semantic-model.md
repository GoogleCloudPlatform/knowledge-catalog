# Deploying a semantic model

A *semantic model* describes your entities (tables), the metrics computed over
them, and the relationships between them, authored as a single
[Apache Ossie](https://ossie.apache.org/) document. `kcmd push` deploys one
model to two destinations at once:

* **BigQuery** — a queryable `CREATE OR REPLACE PROPERTY GRAPH` over the model's
  tables, so the model can be traversed and its metrics computed in SQL.
* **Knowledge Catalog** — catalog entries and links that make the
  model discoverable as metadata.

Both are generated from the same source document — you never author them
separately, and a single `push` keeps them in sync.

This guide covers authoring, deploying, pulling back, and updating a model.
For the Ossie document format itself, see
[ossie.apache.org](https://ossie.apache.org/).

## Prerequisites

`kcmd` authenticates with your `gcloud` credentials. Log in once before pushing:

```bash
gcloud auth application-default login
```

You also need read/write access to whichever destinations you deploy to.

## 1. Author a model

Create the local layout. The scope is the Knowledge Catalog entry group the
model will be published to, written as `<projectId>.<locationId>.<entryGroupId>`:

```bash
kcmd init --semantic-model my-project.us-central1.my_model
```

`init` provisions that entry group (idempotent — an existing group is fine) and
creates its local directory. Author the model at
`catalog/EntryGroups/<entryGroupId>/<model>.yaml`:

```yaml
version: "0.2.0.dev0"

semantic_model:
  - name: sales                              # must match the <model>.yaml filename
    # Required: the deployment target, in a GOOGLE custom extension. `data` is a
    # JSON string whose deploymentTargets holds the target graph URI (for now,
    # exactly one).
    custom_extensions:
      - vendor_name: GOOGLE
        data: '{"deploymentTargets": ["//bigquery.googleapis.com/projects/my-project/datasets/sales/propertyGraphs/sales_graph"]}'
    datasets:                                # each dataset becomes an entity
      - name: orders
        source: my-project.sales.orders      # the backing BigQuery table
        primary_key: [o_orderkey]
        fields:
          - name: o_orderkey
            expression: {dialects: [{dialect: BIGQUERY, expression: o_orderkey}]}
          - name: o_totalprice
            expression: {dialects: [{dialect: BIGQUERY, expression: o_totalprice}]}
    metrics:
      - name: total_revenue
        expression: {dialects: [{dialect: BIGQUERY, expression: SUM(orders.o_totalprice)}]}
```

### Deployment targets (required)

Every model must declare exactly one **deployment target** — the BigQuery
property graph it deploys to — in a `GOOGLE` custom extension, as shown above. A
target is a URI of the form:

```
//bigquery.googleapis.com/projects/<project>/datasets/<dataset>/propertyGraphs/<graphName>
```

The target's project and dataset are where the property graph is created; the
same URIs are also recorded on the model's Knowledge Catalog entry. A model with
no deployment target — or with more than one — is rejected at push time (see
[Validation](#validation)).

### Table sources

Each entity's `source` is its backing BigQuery table. A `source` written as
`dataset.table` (two parts) is qualified with the scope's project — the
`<projectId>` from `init`. Write the full `project.dataset.table` when a table
lives in another project.

Sources are not limited to native BigQuery tables. A name with more than
three parts — for example a four-part `catalog.database.schema.table`
reference — points at a table in a **federated REST catalog**, such as an
Apache Iceberg table exposed through BigLake. Write it exactly as BigQuery
resolves the name, and validation resolves it the same way the deploy does (see
[Validation](#validation)).

## 2. Push

```bash
kcmd push
```

With no flags this deploys to **every** destination, BigQuery first. The flags
below select destinations, dry-run, and preview:

```bash
kcmd push --target bq          # BigQuery only
kcmd push --validate-only      # run all checks, write nothing
kcmd push --print              # also print the generated DDL / entry plan
```

| Flag | Effect |
|------|--------|
| `--target <bq\|kc\|all>` | Which destination(s) to deploy to; accepts a comma-separated list (`bq,kc`). Default `all`. |
| `--validate-only` | Run every validation check and report pass/fail, but write nothing. |
| `--print` | Print each destination's generated artifact (BigQuery DDL, Knowledge Catalog entry plan). Combine with `--validate-only` to preview without deploying. |
| `--force-remove` | Delete models in the entry group that this push no longer includes (see [Updating and removing models](#updating-and-removing-models)). |
| `--emit-expressions` | Also write the SQL-expression fields (per-field `schema.semantics` and `semantic-metric.expression`) to Knowledge Catalog. Off by default: the published system-type templates do not carry them yet. Knowledge Catalog push only. |

Destinations always deploy BigQuery-first and fail fast, so a rejected model
never half-deploys.

### What gets created in BigQuery

`push` executes a single `CREATE OR REPLACE PROPERTY GRAPH` per deployment
target, in the project and dataset the target names. Each part of your model
becomes one part of that graph:

| Model element | BigQuery construct | Notes |
|---|---|---|
| Model | `PROPERTY GRAPH` | named by the deployment-target URI |
| Entity | `NODE TABLE` | backed by the entity's `source` table, keyed by its primary key |
| Relationship | `EDGE TABLE` | connects the two entities' node tables |
| Metric | `MEASURE` on a node table | must resolve to a single entity (otherwise the push is rejected — see [Validation](#validation)) and reduce to one supported aggregate over one operand (otherwise that metric is skipped with a warning) |

`push` reads the target dataset's location (`bigquery.datasets.get`) so the
statement runs in the right region; without that permission it falls back to
BigQuery's own location inference and warns. Under `--validate-only` no graph
DDL is executed and nothing is written (the live source-table checks still run —
see [Validation](#validation)); add `--print` to see the generated DDL.

#### What carries over, and what doesn't

Push preserves both the queryable structure and the descriptive metadata
attached to it. The structure becomes the node tables, edge tables, and
measures; the descriptive metadata is written into each element's `OPTIONS(...)`
in the graph (visible with `--print`). BigQuery's graph `OPTIONS` give an element
a `description` string and a `synonyms` array, so synonyms are carried across
structurally, as their own array — not flattened into the description text.

**Carried over** — for every entity, relationship, metric, and field:

| Authored metadata | Where it lands in the generated DDL |
|---|---|
| `ai_context.synonyms` | the element's `OPTIONS(synonyms=[...])`, a structured array |
| `description` | the element's `OPTIONS(description=...)` |
| `ai_context.instructions` | added to the same `OPTIONS(description=...)` |
| `ai_context.examples` | added to it, as an `Examples: …` line |
| A field's `label` | added to the field's `OPTIONS(description=...)` |
| A field's time-dimension role | noted in the field's `OPTIONS(description=...)` |

**Not carried over:**

| Authored metadata | Why |
|---|---|
| The model's own `description` / `ai_context` | BigQuery silently drops statement-level graph `OPTIONS`, so model-level metadata has no home in the graph. The model's `description` and its `ai_context.instructions` are carried into [Knowledge Catalog](#what-gets-created-in-knowledge-catalog) instead (the model's `ai_context.synonyms`/`examples` are preserved in neither destination) |
| A field's `datatype` | BigQuery uses the source column's own type |
| Unique keys beyond the primary key | only the primary key is emitted |
| The imported vendor SQL and its dialect | only the canonical GoogleSQL expression is used |
| `custom_extensions` | not part of the graph (the model-level `GOOGLE` block only supplies the [deployment target](#deployment-targets-required)) |
| A metric that isn't a single aggregate (`SUM`/`AVG`/`COUNT`/`MIN`/`MAX`) over one operand | it can't become a `MEASURE`, so it is skipped with a warning |

One caveat on the metadata that carries over: `synonyms` is the only part with a
dedicated BigQuery option. The rest — `description`, `instructions`, `examples`,
and a field's `label` — share the single `description` string, so they are
combined into it (examples as an `Examples: …` line). Their content is
preserved; their separate structure is not.

### What gets created in Knowledge Catalog

Each element of your model maps to one catalog resource. Every resource type
below is a built-in system type under `dataplex-types/global` — push references
them, it never creates them.

| Model element | Catalog resource | Kind | Id |
|---|---|---|---|
| Model | `semantic-model` | entry — anchor / parent of the rest | `<model>` |
| Entity | `semantic-entity` (+ built-in `schema` aspect) | entry | `<model>.entities.<entity>` |
| Metric | `semantic-metric` | entry | `<model>.metrics.<metric>` |
| Relationship | `schema-join` | entry link between the two entity entries | derived from the model and relationship names |

An entity entry carries its columns in the `schema` aspect (name, data type,
description, and any `label` per field), plus the entity's keys and unique keys
(`primaryKey` / `uniqueConstraints`); a `schema-join` link carries the
relationship detail — the paired columns and foreign-key direction — in its
aspect. Any element with `ai_context.instructions` (the model, an entity, or a
metric) also gets a built-in `guidelines` aspect holding that text.

> **Note — push to Knowledge Catalog is lossy.** The catalog holds metadata,
> not a full copy of your model. It **stores** names, descriptions, data
> sources, field datatypes and roles, and 1:1 / 1:N relationships (as
> `schema-join` links). It also stores entity keys and unique keys (the built-in
> `schema` aspect's `primaryKey` / `uniqueConstraints`), field labels (the
> `schema` aspect's per-field `annotations`), and `ai_context.instructions` on
> the model, entities, and metrics (the built-in `guidelines` aspect). By
> default it does **not** store the SQL expressions: the published system-type
> templates do not yet carry a per-field `semantics` block or a
> `semantic-metric.expression` field, so the default push omits them (pass
> `--emit-expressions` to write the canonical GoogleSQL/ANSI expression once the
> templates gain the fields). It never stores `ai_context.synonyms`/`examples`,
> field-level `ai_context` (only model/entity/metric instructions have a home),
> or the original vendor SQL (`importedExpression` — e.g. the MAQL or Snowflake
> form a metric was imported from). Those stay in your authored document; the
> vendor SQL and expressions are still used when generating BigQuery SQL. Keep
> your model document as the source of truth.

## Validation

`push` and `--validate-only` run the same checks, **before either destination is
touched**, so a model that cannot deploy fails fast instead of half-deploying:

* **Exactly one deployment target per model, and it must be a valid BigQuery
  Graph URI.** A model with no target — or with more than one — is rejected, and
  so is a single target whose URI does not match
  `//bigquery.googleapis.com/projects/<p>/datasets/<d>/propertyGraphs/<g>` (for
  example a `propertyGraph`/`propertyGraphs` typo, or a
  `…/entryGroups/@bigquery/entries/…` entry form). The error names the offending
  URI and the expected form. This gate runs before any destination leg and for
  every `--target`, so a malformed target writes **nothing** — not to BigQuery
  and **not to Knowledge Catalog**; the push aborts with a non-zero exit and no
  entries are created. *(static)*
* **Every metric on a BigQuery Graph model resolves to exactly one entity** —
  otherwise it would be dropped from the BigQuery Graph. Set the metric's attach
  entity, or scope its expression to a single entity. *(static)*
* **Every entity's source table is reachable.** Each `source` is probed with a
  dry-run query, so BigQuery resolves it exactly as the deploy will — a
  three-part `project.dataset.table`, a four-part federated REST-catalog name
  (e.g. an Iceberg table via BigLake), or a quoted identifier all work. A table
  that does not exist or that you cannot access fails the push, naming the table
  and the entity; a `source` that is a query (not a table) is skipped. *(live —
  needs BigQuery access)*

The live table check runs for **every** `--target`, because the same tables back
both destinations — so even a Knowledge-Catalog-only push confirms the model
could deploy to BigQuery.

## Updating and removing models

Your model document is the source of truth. To change what is deployed, edit
the document and run `kcmd push` again — you never edit the catalog or the
BigQuery Graph by hand. Re-running is safe: each push makes the destinations
match the document as it stands now.

**When you edit an entity, metric, or relationship** — push overwrites the
existing one in place; you don't get duplicates.

**When you delete an entity or metric** — remove it from the document and
push. Push deletes the leftover catalog entry for you (the summary shows
`removed N orphaned entries`).

**When you rename or delete a relationship** — push removes the old
`schema-join` link after writing the new ones, so a rename never leaves the
two entities disconnected (the summary shows `unlinked N orphaned links`).
Relationships owned by other models that share the entry group are left
untouched.

**When you remove a whole model** — deleting its document does *not* remove it
from the catalog. As long as you still push at least one other model in the same
entry group, push stops and names the model the catalog still has that you no
longer push, so you can't wipe one out by accident or by pushing from the wrong
directory; run push again with `--force-remove` to delete its entries and links.
Deleting *every* document is the exception: with no models left to push, the run
reports `No semantic model documents found; nothing to deploy` and touches
nothing — so remove a model while other models in its group remain, or delete
its catalog entries directly.

Every push prints one line per destination summarizing what it did. For a
`--target all` push:

```
Deployed 1 BigQuery Graph(s).
Wrote 5 new and 2 updated Knowledge Catalog entries; removed 1 orphaned entry; linked 2 relationships; unlinked 1 orphaned link.
```

## Pull

`kcmd pull` is the inverse of push's Knowledge Catalog leg: it reads the
`semantic-*` entries back from the catalog and reconstructs local model
documents at `catalog/EntryGroups/<entryGroupId>/<model>.yaml`. Use it to
recover a workspace from a catalog someone else deployed, or to see what the
catalog actually holds.

```bash
kcmd pull
```

Pull reads only from Knowledge Catalog (never BigQuery). Its coordinates come
from the same scope you authored under (`<projectId>.<locationId>.<entryGroupId>`).

| Flag | Effect |
|------|--------|
| `--dry-run` | Reconstruct from the catalog and report what would be written, but write no files. |
| `--force-remove` | Replace a differently-named local model with the catalog's (see below); without it, a pull that would leave the entry group holding two models fails. |

An entry group holds **exactly one** semantic model. Pull reconstructs that one
model's document; a group with more than one `semantic-model` anchor is an
unexpected state, so pull stops and names the anchors rather than guess which to
keep.

Pull overwrites a model that already exists locally in place. If the catalog's
model has a **different name** than the one on disk, writing it would leave the
entry group holding two models — so by default pull stops and reports the
mismatch instead of deleting anything. Re-run with `--force-remove` to delete the
local model and replace it with the catalog's. Pull never touches BigQuery.

> **Note — pull reconstructs what the catalog holds, not your original file.**
> Pull can only recover what push wrote (see the note under [What gets created in
> Knowledge Catalog](#what-gets-created-in-knowledge-catalog)). What that means in
> practice:
>
> **Recovered exactly** — these come back as authored:
> - Model structure: the model, its entities, and each entity's fields.
> - Each field's data source (its data type round-trips with the two collapses
>   noted below).
> - Entity keys and unique keys (from the `schema` aspect's `primaryKey` /
>   `uniqueConstraints`).
> - Field labels (from the `schema` aspect's per-field `annotations`).
> - `ai_context.instructions` on the model, entities, and metrics (from the
>   `guidelines` aspect).
> - Metrics: name and attach entity (a concrete data type round-trips; see below).
> - 1:1 / 1:N relationships: endpoints, foreign-key direction, and join columns
>   (from the `schema-join` links).
> - Deployment targets.
>
> **Recovered only if pushed with `--emit-expressions`** — the per-field
> `semantics` block (expressions and the dimension role) and the metric
> expression are omitted from the catalog by default (see the note above), so
> pull returns them only when the push that wrote them used `--emit-expressions`:
> - Field expressions and metric expressions (the canonical GoogleSQL/ANSI form).
> - A field's dimension role, which comes back as a bare `dimension: {}` marker,
>   without its detail (`is_time`, and so on). A default push drops the marker
>   entirely.
>
> **Recovered, but normalized** — the content survives, the form changes:
> - Relationship *names* come back lowercased/hyphenated (the catalog stores the
>   name only in the link id, e.g. `Places Order` → `places-order`).
> - Field types round-trip except for two collapses: a field authored with no
>   type comes back as `Opaque`, and a field authored as `String` comes back
>   un-typed (`String` and un-typed both store as a plain catalog `STRING`).
> - A metric's data type round-trips only for a concrete type (e.g. `Decimal`);
>   an untyped, `String`, or `Opaque` metric comes back un-typed, because the
>   metric aspect stores a data type but no metadata type to mark it `Opaque`.
> - Ordering: field order within each entity is preserved, but the order of
>   entities and metrics is not — they come back in the catalog's own order, not
>   the authored one. Comments in the original YAML are not preserved.
>
> **Not recovered** — push never wrote these, so pull cannot return them:
> - `ai_context.synonyms` and `ai_context.examples` (only `instructions` has a
>   home, in the `guidelines` aspect).
> - Field-level `ai_context` (only the model, entities, and metrics get a
>   `guidelines` aspect).
> - The original vendor SQL (`importedExpression` / `importedDialect`).
> - M:N (`association`) relationships.
>
> **So: a push followed by a pull does not return your original file.** Treat a
> pulled document as a faithful copy of the catalog metadata, not of the authored
> model, and keep the authored document as the source of truth.

> **Note — writer-side follow-up (not inherent to pull).** One reduction above is
> a limit of what push currently *writes*, not of what pull can recover. It is
> recorded here as a write-side follow-up; the reader (pull) already returns
> everything the catalog holds.
>
> - **Relationship names.** The `schema-join` aspect type's `metadataTemplate` has
>   no field for the relationship name, so push cannot store it and pull recovers
>   it from the link id — which is lowercased and hyphenated (the entry-link id
>   format forbids the original casing/underscores). Returning the name verbatim
>   requires adding a name field to the built-in `schema-join` aspect type in
>   Knowledge Catalog (server-side), after which the client write/read is trivial;
>   it is the same class of gap as the `semantics` field that gates
>   `--emit-expressions`.
>
> (A non-canonical deployment target is **not** a pull gap: push rejects it at the
> validation gate before any leg runs, so it is never written — see
> [Validation](#validation).)

## Importing an OWL ontology

An OWL ontology and a semantic model share a backbone: **classes ≈ entities**,
**object properties ≈ relationships**, **datatype properties ≈ fields**. `kcmd`
does not learn a second format — it **converts OWL into a semantic model** once,
then the ontology rides the normal `kcmd push` / `kcmd pull` above. The semantic
model stays the single canonical form.

This first cut converts only the OWL constructs that have a clean BigQuery Graph
shape (class → node, object property → edge, datatype property → property).
Richer OWL (`subClassOf`, `inverseOf`, SHACL, cardinality, individuals) is not
read yet — see [What is not covered yet](#what-is-not-covered-yet).

### 1. The OWL file

A small sales ontology, `sales.owl.ttl` — two classes, four datatype properties,
one object property. Nothing here needs an OWL reasoner:

```turtle
@prefix owl:  <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
@prefix ex:   <http://example.com/sales#> .

ex:Customer a owl:Class ;
    rdfs:label   "Customer" ;
    rdfs:comment "A person or organization that places orders." .

ex:Order a owl:Class ;
    rdfs:label   "Order" ;
    rdfs:comment "A purchase placed by a customer." .

ex:customerName a owl:DatatypeProperty ;
    rdfs:domain ex:Customer ; rdfs:range xsd:string ; rdfs:label "name" .

ex:signupDate a owl:DatatypeProperty ;
    rdfs:domain ex:Customer ; rdfs:range xsd:date .

ex:orderAmount a owl:DatatypeProperty ;
    rdfs:domain ex:Order ; rdfs:range xsd:decimal .

ex:orderDate a owl:DatatypeProperty ;
    rdfs:domain ex:Order ; rdfs:range xsd:date .

ex:placedBy a owl:ObjectProperty ;
    rdfs:domain  ex:Order ; rdfs:range ex:Customer ;
    rdfs:label   "placed by" ;
    rdfs:comment "Links an order to the customer who placed it." .
```

### 2. The command

```console
$ kcmd owl import sales.owl.ttl
converted 2 classes, 1 object property, 4 datatype properties
wrote catalog/EntryGroups/<entryGroup>/sales.yaml
note: this model is UNBOUND (no backing tables yet).
      -> `kcmd push --target kc` works now (publishes ontology metadata).
      -> `kcmd push --target bq` is skipped until you bind sources.
```

The model name comes from the file (`sales.owl.ttl` → `sales`). By default the
document is written into the semantic-model layout dir so the next `kcmd push`
picks it up; pass `--out <path>` to write it elsewhere.

### 3. The semantic model it produces — `sales.yaml`

Note what is **not** here: no IRIs, no `custom_extensions`. Every OWL term has an
IRI (`ex:Customer` = `http://example.com/sales#Customer`), but for the
constructs that map cleanly, the IRI carries nothing the model doesn't already
have — the term's identity is its name, and the source namespace is recorded once
in the model `description` as provenance.

```yaml
version: 0.2.0.dev0
semantic_model:
  - name: sales
    description: Imported from OWL ontology http://example.com/sales#
    datasets:
      - name: Customer
        source: unbound:Customer        # placeholder — bind to a table for BigQuery Graph
        description: A person or organization that places orders.
        fields:
          - name: customerName
            expression:
              dialects:
                - dialect: BIGQUERY
                  expression: customerName
            datatype: String
            label: name
          - name: signupDate
            expression:
              dialects:
                - dialect: BIGQUERY
                  expression: signupDate
            datatype: Date
      - name: Order
        source: unbound:Order
        description: A purchase placed by a customer.
        fields:
          - name: orderAmount
            expression:
              dialects:
                - dialect: BIGQUERY
                  expression: orderAmount
            datatype: Decimal
          - name: orderDate
            expression:
              dialects:
                - dialect: BIGQUERY
                  expression: orderDate
            datatype: Date
    relationships:
      - name: placedBy
        from: Order
        to: Customer
        # UNBOUND: real FK/key columns are unknown until sources are bound.
        from_columns:
          - TODO_BIND
        to_columns:
          - TODO_BIND
        ai_context:
          instructions: Links an order to the customer who placed it.
```

#### How each OWL construct landed

| OWL | Semantic model | Notes |
|---|---|---|
| `owl:Class` | `datasets[]` entry | `source` = `unbound:<Name>` placeholder until bound |
| `owl:DatatypeProperty` | `fields[]` on the domain's dataset | `expression` defaults to the property's local name (a valid column ref once bound) |
| `rdfs:range xsd:*` | field `datatype` | `xsd:string→String`, `xsd:date→Date`, `xsd:decimal→Decimal`, else `Opaque` |
| `owl:ObjectProperty` | `relationships[]` | `from`=domain, `to`=range; join columns unbound (`TODO_BIND`) |
| `rdfs:label` on a datatype property | field `label` | the field's display name (a `label` slot exists only on fields); dropped when it only respaces/recases the name |
| `rdfs:label` on a class / object property | `ai_context.synonyms` | no `label` slot there, so a distinct label becomes an alternate name; dropped when it only respaces/recases the name |
| extra `rdfs:label` / `skos:altLabel` / `skos:prefLabel` | `ai_context.synonyms` | genuinely alternate names; feed NL search |
| `rdfs:comment` on a class / datatype property | `description` | |
| `rdfs:comment` on an object property | `ai_context.instructions` | a relationship has no `description` slot, so its comment rides in `ai_context` |
| term IRIs, `@prefix` | dropped (provenance kept in model `description`) | reconstructable as `<base><name>`; re-carried only if reverse export or `subClassOf` needs them |

A datatype property whose domain is not a class in the ontology, or an object
property missing an endpoint, cannot be placed; it is **skipped with a warning**
rather than failing the whole import.

### 4. Going from ontology to a running graph (binding)

The import gets you a **KC-ready, BQ-pending** model. Publish the ontology as
catalog metadata immediately:

```console
$ kcmd push --target kc      # Customer/Order entries + placedBy link appear in Knowledge Catalog
```

To make it queryable in **BigQuery Graph**, bind each class to a real table by
editing the `unbound:` / `TODO_BIND` spots — `source` (+ `primary_key`) per
dataset, and the relationship's join columns:

```yaml
  - name: Customer
    source: myproj.sales.customers
    primary_key:
      - customer_id
    fields:
      - name: customerName
        expression:
          dialects:
            - dialect: BIGQUERY
              expression: name
        datatype: String
  # ...Order bound to myproj.sales.orders, primary_key [order_id]...
  relationships:
    - name: placedBy
      from: Order
      to: Customer
      from_columns:
        - customer_id
      to_columns:
        - customer_id
```

You also need a [deployment target](#deployment-targets-required) on the model
before a BigQuery push. Binding is a manual edit in this first cut.

### What is not covered yet

- `rdfs:subClassOf`, `owl:inverseOf`, `rdfs:subPropertyOf` — not read yet. When
  added, they will land in a GOOGLE `custom_extensions` block (under a
  `data.ontology` key), which is also where the base IRI + prefixes come back
  (needed to expand parent-class/property references).
- SHACL shapes, cardinality, `owl:unionOf` domains, symmetric/transitive
  properties, `equivalentClass`, individuals — not read.
- Semantic model → OWL export (reverse) — not built; import is one-way.
- OWL serializations other than Turtle (`.ttl`) — not read.

## Permissions

`push` needs access to whichever destinations you deploy to.

**BigQuery** — for `--target bq` or `all`, and for the validation pre-flight:

* `bigquery.jobs.create` in the deployment-target project — to run the deploy's
  `CREATE OR REPLACE PROPERTY GRAPH` and the validation dry-run query
* read access on each entity's source table, so the dry-run can resolve it
* `bigquery.datasets.get` on the target dataset (region detection; optional —
  push degrades gracefully without it)

**Knowledge Catalog / Dataplex** — for `--target kc` or `all`:

* `dataplex.entryGroups.useSemanticModelAspect`,
  `dataplex.entryGroups.useSemanticEntityAspect`, and
  `dataplex.entryGroups.useSemanticMetricAspect` on the destination entry group
* `dataplex.entryGroups.useSchemaAspect` on the destination entry group — every
  entity carries the built-in `schema` aspect (its fields, keys, unique keys,
  and labels)
* `dataplex.entryGroups.useGuidelinesAspect` when any element carries
  `ai_context.instructions` (the model, an entity, or a metric)
* `dataplex.entryGroups.useSchemaJoinEntryLink` and
  `dataplex.entryGroups.useSchemaJoinAspect` when the model has relationships

`kcmd pull` needs read access to the same entry group instead — to list its
entries and fetch each `semantic-*` entry with its aspects.
