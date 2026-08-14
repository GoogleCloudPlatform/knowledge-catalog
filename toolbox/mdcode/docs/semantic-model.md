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
| Metric | `MEASURE` on a node table | must reduce to one aggregate over one entity, or it is skipped with a warning |

`push` reads the target dataset's location (`bigquery.datasets.get`) so the
statement runs in the right region; without that permission it falls back to
BigQuery's own location inference and warns. Nothing runs under
`--validate-only`; add `--print` to see the DDL.

Push to BigQuery is **lossy**: the graph captures the queryable structure —
node tables, edge tables, and measures — but not descriptive metadata
(descriptions, `ai_context`, synonyms, labels), and a metric that does not
reduce to a single MEASURE is dropped with a warning. It is a query surface,
not a copy of your model.

### What gets created in Knowledge Catalog

Each element of your model maps to one catalog resource. Every resource type
below is a built-in system type under `dataplex-types/global` — push references
them, it never creates them.

| Model element | Catalog resource | Kind | Id |
|---|---|---|---|
| Model | `semantic-model` | entry — anchor / parent of the rest | `<model>` |
| Entity | `semantic-entity` (+ built-in `schema` aspect) | entry | `<model>.entities.<entity>` |
| Metric | `semantic-metric` | entry | `<model>.metrics.<metric>` |
| Relationship | `schema-join` | entry link between the two entity entries | derived from the relationship name |

An entity entry carries its columns in the `schema` aspect (name, data type, and
description per field); a `schema-join` link carries the relationship detail — the
paired columns and foreign-key direction — in its aspect.

> **Note — push to Knowledge Catalog is lossy.** The catalog holds metadata,
> not a full copy of your model. It **stores** names, descriptions, data
> sources, field datatypes and roles, and 1:1 / 1:N relationships (as
> `schema-join` links). By default it does **not** store the SQL expressions:
> the published system-type templates do not yet carry a per-field `semantics`
> block or a `semantic-metric.expression` field, so the default push omits them
> (pass `--emit-expressions` to write the canonical GoogleSQL/ANSI expression
> once the templates gain the fields). It never stores entity keys, `ai_context`,
> field labels, the original vendor SQL (`importedExpression` — e.g. the MAQL or
> Snowflake form a metric was imported from), or M:N relationships. Those stay in
> your authored document (and, for the edges, in the BigQuery property graph); the
> vendor SQL and expressions are still used when generating BigQuery SQL. Keep
> your model document as the source of truth.

## Validation

`push` and `--validate-only` run the same checks, **before either destination is
touched**, so a model that cannot deploy fails fast instead of half-deploying:

* **Exactly one deployment target per model.** *(static)*
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
from the catalog on the next push. Instead, push stops and names the model the
catalog still has that you no longer push, so you can't wipe out a model by
accident or by pushing from the wrong directory. When you do mean to remove it,
run push again with `--force-remove` and its entries and links are deleted
first.

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
| `--model <name>` | Pull a single model by name; other models in the entry group are left alone. |

One entry group can hold **many models** — each `semantic-model` entry is a
separate anchor, and pull reconstructs one document per anchor. `--model`
narrows both the fetch and the write to a single anchor.

Pull writes with the same last-write-wins policy as the core pull: a model that
already exists locally is overwritten in place, and a local-only document (one
with no matching catalog entry) is left untouched — pull never deletes.

> **Note — pull reconstructs what the catalog holds, not your original file.**
> Pull can only recover what push wrote (see the note under [What gets created in
> Knowledge Catalog](#what-gets-created-in-knowledge-catalog)). What that means in
> practice:
>
> **Recovered exactly** — these come back as authored:
> - Model structure: the model, its entities, and each entity's fields.
> - Field data source and data type.
> - Metrics: name, data type, and attach entity.
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
> - A metric authored with no data type comes back as an explicit `Decimal`
>   (push must write a type, and defaults it to `NUMERIC`).
>
> **Not recovered** — push never wrote these, so pull cannot return them:
> - Entity keys / unique keys.
> - `ai_context`.
> - Field labels.
> - The original vendor SQL (`importedExpression`).
> - M:N relationships (the edge lives only in the BigQuery property graph).
>
> **So: a push followed by a pull does not return your original file.** Treat a
> pulled document as a faithful copy of the catalog metadata, not of the authored
> model, and keep the authored document as the source of truth.

> **Note — writer-side follow-ups (not inherent to pull).** Two of the reductions
> above are limits of what push currently *writes*, not of what pull can recover.
> They are recorded here as write-side follow-ups; the reader (pull) already
> returns everything the catalog holds.
>
> - **Relationship names.** The `schema-join` aspect does not store the authored
>   relationship name, so pull recovers it from the link id — which is lowercased
>   and hyphenated. Persisting the name in the aspect on write would let pull
>   return it verbatim.
> - **Non-canonical deployment targets.** Push persists a target only when it is a
>   canonical BigQuery Graph URL
>   (`//bigquery.googleapis.com/projects/.../datasets/.../propertyGraphs/...`).
>   Other forms — a misspelled path, or the `projects/.../entryGroups/@bigquery/`
>   entry form — are dropped on write, so pull has nothing to recover. Widening or
>   normalizing the writer's accepted forms would let them round-trip.

## Permissions

`push` needs access to whichever destinations you deploy to.

**BigQuery** — for `--target bq` or `all`, and for the validation pre-flight:

* `bigquery.jobs.create` in the deployment-target project — to run the deploy's
  `CREATE OR REPLACE PROPERTY GRAPH` and the validation dry-run query
* read access on each entity's source table, so the dry-run can resolve it
* `bigquery.datasets.get` on the target dataset (region detection; optional —
  push degrades gracefully without it)

**Knowledge Catalog / Dataplex** — for `--target kc` or `all`:

* `dataplex.entryGroups.useSemanticModelAspect` on the destination entry group
* `dataplex.entryGroups.useSchemaJoinEntryLink` and
  `dataplex.entryGroups.useSchemaJoinAspect` when the model has relationships

`kcmd pull` needs read access to the same entry group instead — to list its
entries and fetch each `semantic-*` entry with its aspects.
