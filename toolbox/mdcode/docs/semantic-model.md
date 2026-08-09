# Semantic model push

A *semantic model* describes entities (tables), the metrics computed over them,
and the relationships between them, authored as a single
[Apache Ossie](https://ossie.dev) document in your catalog snapshot. `kcmd push`
deploys that model to two destinations:

* **BigQuery** — a `CREATE OR REPLACE PROPERTY GRAPH` over the model's tables.
* **Knowledge Catalog (Dataplex)** — catalog entries and links that describe the
  model as metadata.

Both destinations are generated from the same model; you never author them
separately.

## Author a model

Create the local layout for a model. The scope names the Dataplex EntryGroup the
model belongs to:

```bash
kcmd init --semantic-model <projectId>.<locationId>.<entryGroupId>
```

The model is authored at
`catalog/EntryGroups/<entryGroupId>/<model>.yaml`. `init` also provisions the
destination EntryGroup (idempotent — an existing group is fine); `push` only ever
writes entries into it.

### Deployment targets (required)

Every model must declare at least one **deployment target** in its GOOGLE
`custom_extension`. A BigQuery Graph target is a URI of the form:

```
//bigquery.googleapis.com/projects/<project>/datasets/<dataset>/propertyGraphs/<graphName>
```

The target's project and dataset are where the property graph is created, and the
same URIs are recorded on the Knowledge Catalog `semantic-model` entry. A model
with no deployment target is rejected at push time (see **Validation** below).

A table `dataSource` that omits its project is qualified with the scope's
declared project (the `<projectId>` in the `init` scope), not your ambient
`gcloud` project. Write a fully-qualified `project.dataset.table` when the tables
live elsewhere.

## Push

```bash
# Deploy to every destination (the default).
kcmd push

# Deploy to one or a subset.
kcmd push --target bq
kcmd push --target kc
kcmd push --target bq,kc

# Dry run: validate and show what would be written, without touching anything.
kcmd push --validate-only

# Print each destination's generated artifact in its native format
# (BigQuery Graph SQL DDL, Knowledge Catalog entry plan). Scoped by --target;
# works with or without --validate-only.
kcmd push --print
```

`--target` is the single control for destination selection; its default is `all`.
Targets are always deployed BigQuery-first and fail fast, so a bad model never
half-deploys.

### What the BigQuery leg does

It executes `CREATE OR REPLACE PROPERTY GRAPH` against the project and dataset
named by each BigQuery deployment target. It also reads the target dataset's
metadata (`bigquery.datasets.get`) to pin the query's processing location; this
degrades gracefully when the permission is absent, falling back to BigQuery's own
location inference. `--validate-only` prints the DDL without executing it.

### What the Knowledge Catalog leg writes

The model becomes catalog **entries**, all built-in system types under
`dataplex-types/global` (push references them; it never creates types):

| Entry             | Represents                                             |
|-------------------|-------------------------------------------------------|
| `semantic-model`  | the model (the anchor / parent of the others)         |
| `semantic-entity` | one entity — carries its `schema` (fields + semantics) |
| `semantic-metric` | one metric — its data type and expression             |

Entry ids are derived from names: `<model>`, `<model>.entities.<entity>`,
`<model>.metrics.<metric>`.

Each **relationship** becomes a `schema-join` **entry link** between the two
entity entries. The join detail (paired columns, foreign-key direction) lives in
the link's aspect. Many-to-many (association / junction-table) relationships are
**not** published to the catalog yet — the push warns and skips them; the edge
still exists in the BigQuery property graph.

Only the canonical `expression` (GoogleSQL/ANSI) is published to the catalog. The
original vendor SQL (`importedExpression`) is kept in your source model and used
as a fallback when generating BigQuery SQL, but it is not written to the catalog,
which has no consumer for it.

Push requires `dataplex.entryGroups.useSemanticModelAspect` on the destination
entry group, plus `useSchemaJoinEntryLink` / `useSchemaJoinAspect` when the model
has relationships.

## Validation

The same checks gate a real push and `--validate-only`, and run **before** either
destination is touched, so a model that cannot deploy fails fast:

* **Every model must declare at least one deployment target.** (static)
* **On a BigQuery-graph model, every metric must resolve to exactly one entity**
  — otherwise it cannot lower to a MEASURE and would be dropped from the graph.
  Set the metric's attach entity, or scope its expression to a single entity.
  (static)
* **Every entity's BigQuery source table must be reachable.** Each entity's
  `dataSource` that is a plain `project.dataset.table` is probed against BigQuery;
  a table that does not exist or that you cannot access fails the push, naming the
  table and the entity. This runs for every `--target` (the entity tables back
  both legs) and confirms the model can deploy before any write to BigQuery *or*
  Knowledge Catalog. Sources that are queries or are not plain table references
  are skipped. (live — needs BigQuery read access)

## Re-push, updates, and cleanup

Push is idempotent and reconciles the catalog to match your model:

* **Re-push upserts.** An entry or link that already exists is updated in place.
* **Removed entity or metric.** If you delete an entity or metric from a model
  and push again, its orphaned entry is deleted. Reported as
  `removed N orphaned entr(y|ies)`.
* **Removed or renamed relationship.** The stale `schema-join` link is deleted
  after the current links are written (a rename never leaves the pair with no
  link). Reported as `unlinked N orphaned link(s)`. Links belonging to other
  models in a shared entry group are never touched.
* **Removed or renamed whole model.** If the entry group already contains a model
  your push does not include, push **refuses** with an error naming it, rather
  than leaving a stale model or silently deleting one. Re-run with
  **`--force-remove`** to delete that model's links and entries first, then write
  your current models.

A typical push summary reads:

```
Pushed 7 Knowledge Catalog entries; removed 1 orphaned entry; linked 2 relationships; unlinked 1 orphaned link.
```

## Authentication

The CLI uses `gcloud` for auth tokens; run
`gcloud auth application-default login` first.
