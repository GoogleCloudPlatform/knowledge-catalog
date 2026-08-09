# Deploying a semantic model

A *semantic model* describes your entities (tables), the metrics computed over
them, and the relationships between them, authored as a single
[Apache Ossie](https://ossie.dev) document. `kcmd push` deploys one model to two
destinations at once:

* **BigQuery** — a queryable `CREATE OR REPLACE PROPERTY GRAPH` over the model's
  tables, so the model can be traversed and its metrics computed in SQL.
* **Knowledge Catalog (Dataplex)** — catalog entries and links that make the
  model discoverable as metadata.

Both are generated from the same source document — you never author them
separately, and a single `push` keeps them in sync.

This guide covers authoring, deploying, and updating a model. For the Ossie
document format itself, see [ossie.dev](https://ossie.dev).

## Prerequisites

`kcmd` authenticates with your `gcloud` credentials. Log in once before pushing:

```bash
gcloud auth application-default login
```

You also need read/write access to whichever destinations you deploy to — see
[Permissions](#permissions).

## 1. Author a model

Create the local layout. The scope is the Dataplex EntryGroup the model will be
published to, written as `<projectId>.<locationId>.<entryGroupId>`:

```bash
kcmd init --semantic-model my-project.us.my_models
```

`init` provisions that EntryGroup (idempotent — an existing group is fine) and
creates its local directory. Author the model at
`catalog/EntryGroups/<entryGroupId>/<model>.yaml`:

```yaml
version: "0.2.0.dev0"

semantic_model:
  - name: sales
    # Required: at least one deployment target, in a GOOGLE custom extension.
    # `data` is a JSON string whose deploymentTargets is a list of graph URIs.
    custom_extensions:
      - vendor_name: GOOGLE
        data: '{"deploymentTargets": ["//bigquery.googleapis.com/projects/my-project/datasets/sales/propertyGraphs/sales_graph"]}'
    datasets:                                # each dataset becomes an entity
      - name: orders
        source: my-project.sales.orders      # the backing BigQuery table
        primary_key: [o_orderkey]
        fields:
          - name: o_orderkey
            expression: {dialects: [{dialect: ANSI_SQL, expression: o_orderkey}]}
          - name: o_totalprice
            expression: {dialects: [{dialect: ANSI_SQL, expression: o_totalprice}]}
    metrics:
      - name: total_revenue
        expression: {dialects: [{dialect: ANSI_SQL, expression: SUM(orders.o_totalprice)}]}
```

### Deployment targets (required)

Every model must declare at least one **deployment target** — the BigQuery
property graph it deploys to — in a `GOOGLE` custom extension, as shown above. A
target is a URI of the form:

```
//bigquery.googleapis.com/projects/<project>/datasets/<dataset>/propertyGraphs/<graphName>
```

The target's project and dataset are where the property graph is created; the
same URIs are also recorded on the model's Knowledge Catalog entry. A model with
no deployment target is rejected at push time (see [Validation](#validation)).

### Table sources

Each entity's `source` is its backing BigQuery table. A `source` written as
`dataset.table` (two parts) is qualified with the scope's project — the
`<projectId>` from `init`, *not* your ambient `gcloud` project. Write the full
`project.dataset.table` when a table lives in another project.

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

Destinations always deploy BigQuery-first and fail fast, so a rejected model
never half-deploys.

### What gets created in BigQuery

`push` executes `CREATE OR REPLACE PROPERTY GRAPH` in the project and dataset
named by each deployment target. It reads the target dataset's location
(`bigquery.datasets.get`) so the statement runs in the right region; if it can't
(missing permission), it falls back to BigQuery's own location inference and
warns. Nothing runs under `--validate-only`; add `--print` to see the DDL.

### What gets created in Knowledge Catalog

The model becomes catalog **entries** of the built-in system types under
`dataplex-types/global` (push references these types; it never creates them):

| Entry | Represents |
|-------|-----------|
| `semantic-model` | the model — the anchor / parent of the others |
| `semantic-entity` | one entity — carries its `schema` (fields + semantics) |
| `semantic-metric` | one metric — its data type and expression |

Entry ids are derived from names: `<model>`, `<model>.entities.<entity>`, and
`<model>.metrics.<metric>`.

Each **relationship** becomes a `schema-join` **entry link** between the two
entity entries; the join detail (paired columns, foreign-key direction) lives in
the link's aspect. Many-to-many (association / junction-table) relationships are
**not** published to the catalog yet — push warns and skips them, though the edge
still exists in the BigQuery property graph.

> **Note:** only the canonical `expression` (GoogleSQL/ANSI) is written to the
> catalog. The original vendor SQL (`importedExpression`) stays in your source
> model — it is still used as a fallback when generating BigQuery SQL — but the
> catalog has no consumer for it.

## Validation

`push` and `--validate-only` run the same checks, **before either destination is
touched**, so a model that cannot deploy fails fast instead of half-deploying:

* **At least one deployment target per model.** *(static)*
* **Every metric on a BigQuery-graph model resolves to exactly one entity** —
  otherwise it cannot lower to a MEASURE and would be dropped from the graph. Set
  the metric's attach entity, or scope its expression to a single entity.
  *(static)*
* **Every entity's source table is reachable.** Each `source` that is a plain
  `project.dataset.table` is probed against BigQuery; a table that does not exist
  or that you cannot access fails the push, naming the table and the entity.
  Sources that are queries or non-table references are skipped. *(live — needs
  BigQuery read access; see [Permissions](#permissions))*

The live table check runs for **every** `--target`, because the same tables back
both destinations — so even a Knowledge-Catalog-only push confirms the model
could deploy to BigQuery.

## Updating and removing models

`push` is idempotent: re-running reconciles each destination to match your
current model.

* **Re-push updates in place.** An existing entry or link is upserted.
* **Removed entity or metric** — its now-orphaned catalog entry is deleted.
  (`removed N orphaned entr(y|ies)`)
* **Removed or renamed relationship** — the stale `schema-join` link is deleted
  after the current links are written, so a rename never leaves the pair
  unlinked. (`unlinked N orphaned link(s)`) Links owned by other models in a
  shared entry group are never touched.
* **Removed or renamed whole model** — if the entry group still contains a model
  your push no longer includes, push **refuses** and names it, rather than
  leaving a stale model or silently deleting one. Re-run with **`--force-remove`**
  to delete that model's entries and links first.

Each destination prints a one-line summary. For a `--target all` push:

```
Deployed 1 BigQuery Graph(s).
Wrote 5 new and 2 updated Knowledge Catalog entries; removed 1 orphaned entry; linked 2 relationships; unlinked 1 orphaned link.
```

## Permissions

`push` needs access to whichever destinations you deploy to.

**BigQuery** — for `--target bq` or `all`, and for the validation table check:

* permission to run `CREATE OR REPLACE PROPERTY GRAPH` in the target dataset
  (create/replace tables and run jobs)
* `bigquery.tables.get` on each entity's source table (validation pre-flight)
* `bigquery.datasets.get` on the target dataset (region detection; optional —
  push degrades gracefully without it)

**Knowledge Catalog / Dataplex** — for `--target kc` or `all`:

* `dataplex.entryGroups.useSemanticModelAspect` on the destination entry group
* `dataplex.entryGroups.useSchemaJoinEntryLink` and
  `dataplex.entryGroups.useSchemaJoinAspect` when the model has relationships
