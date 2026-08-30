# Deploying a semantic model

A *semantic model* describes your entities (tables), the metrics computed over
them, and the relationships between them, authored as a single
[Apache Ossie](https://ossie.apache.org/) document. `kcmd push` deploys one
model to two destinations at once:

* **A property graph** — a queryable `CREATE OR REPLACE PROPERTY GRAPH` over the
  model's tables, so the model can be traversed (and, on BigQuery, its metrics
  computed) in SQL. The graph backend is **BigQuery Graph** or **Spanner
  Graph**, chosen by the deployment target you declare — the same authored model
  deploys to either (see [Deployment targets](#deployment-targets-required)).
* **Knowledge Catalog** — catalog entries and links that make the
  model discoverable as metadata.

Both are generated from the same source document — you never author them
separately, and a single `push` keeps them in sync.

This page is the deploy walkthrough: author a model, push it, update it, pull it
back. For the Ossie document format itself, see
[ossie.apache.org](https://ossie.apache.org/).

### The rest of the guide

| Page | Open it to… |
|---|---|
| **This page** | author a model and deploy it |
| [End-to-end codelab](codelab.md) | see the whole lifecycle: author, govern, hydrate, query |
| [Reference](reference.md) | look up a flag, what push creates, validation, or permissions |
| [What push and pull preserve](fidelity.md) | understand why something changed or wasn't recovered |
| [Importing an OWL ontology](owl-import.md) | start from an OWL ontology instead of hand-authoring |

## Prerequisites

`kcmd` uses your `gcloud` configuration for credentials, project, and location.
Before pushing, authenticate and make sure a project and region are set — `kcmd`
errors out immediately if any of the three is missing:

```bash
gcloud auth application-default login
gcloud config set project <your-project>
gcloud config set compute/region <your-region>
```

You also need read/write access to whichever destinations you deploy to — see
[Permissions](reference.md#permissions).

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
  - name: sales                              # keep equal to the <model>.yaml filename (pull round-trips to that name)
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

Entities can **extend** other entities (`extends: [Parent]`); push flattens the
supertype's fields down and expresses the hierarchy as BigQuery labels. See
[Class hierarchies](reference.md#class-hierarchies-extends--labels) for the
rules.

### Deployment targets (required)

Every model must declare exactly one **deployment target** — the property graph
it deploys to — in a `GOOGLE` custom extension, as shown above. The target's
**host selects the graph backend**:

```
# BigQuery Graph
//bigquery.googleapis.com/projects/<project>/datasets/<dataset>/propertyGraphs/<graphName>

# Spanner Graph
//spanner.googleapis.com/projects/<project>/instances/<instance>/databases/<database>/propertyGraphs/<graphName>
```

A BigQuery target's project and dataset are where the property graph is created;
a Spanner target's instance and database are. Swapping one target URI for the
other is all it takes to deploy the same model to the other backend. The target
is also recorded on the model's Knowledge Catalog entry. A model with no
deployment target — or with more than one — is rejected at push time (see
[Validation](reference.md#validation)).

### Table sources

Each entity's `source` is its backing table.

For a **BigQuery** target, `source` is the BigQuery table. A `source` written as
`dataset.table` (two parts) is qualified with the scope's project — the
`<projectId>` from `init`. Write the full `project.dataset.table` when a table
lives in another project. Sources are not limited to native BigQuery tables: a
name with more than three parts — for example a four-part
`catalog.database.schema.table` reference — points at a table in a **federated
REST catalog**, such as an Apache Iceberg table exposed through BigLake. Write it
exactly as BigQuery resolves the name, and validation resolves it the same way
the deploy does (see [Validation](reference.md#validation)).

For a **Spanner** target, the graph and its tables live inside the one Spanner
database the target names, so a `source` is reduced to its **final segment** —
the table name in that database (`demo.sales.Orders` → `Orders`). That lets one
authored `source` serve both backends; a Spanner-native `source` form is a
planned [profiles](profiles.md) feature.

## 2. Push

```bash
kcmd push
```

With no flags this deploys to **every** destination — the model's graph backend
(BigQuery Graph or Spanner Graph, whichever its target names) and Knowledge
Catalog — the graph first. You don't pick the graph backend on the command line;
the model's deployment target (or the [profile](profiles.md) you merge) does. The
most common flags:

```bash
kcmd push                      # deploy the graph backend + Knowledge Catalog
kcmd push --no-kc              # deploy only the graph, skip Knowledge Catalog
kcmd push --profile analytical # merge a binding profile; its target picks the backend
kcmd push --validate-only      # run all checks, write nothing
kcmd push --print              # also print the generated DDL / entry plan
```

A logical model that declares no deployment target has no graph to deploy, so a
bare `kcmd push` records it to Knowledge Catalog alone (and `--no-kc` on such a
model is an error — it would have nowhere to go).

See [Reference → push flags](reference.md#push) for the full list. The graph leg
deploys first and fails fast, so a rejected model never half-deploys — the checks
that gate it are in [Validation](reference.md#validation).

**What push creates.** In **BigQuery**, a single `CREATE OR REPLACE PROPERTY
GRAPH` per deployment target: each entity becomes a node table, each relationship
an edge table, each metric a measure. In **Spanner**, the same
`CREATE OR REPLACE PROPERTY GRAPH` with bare table names and no measures —
Spanner Graph has no `MEASURE`, so metrics are dropped with a warning while the
graph structure (nodes, edges, labels, inheritance) still deploys. In
**Knowledge Catalog**, one entry per model, entity, and metric, plus
`schema-join` links for relationships. The exact mapping — and the
class-hierarchy handling — is in
[Reference → What gets created](reference.md#what-gets-created-in-bigquery) (and
[in Spanner](reference.md#what-gets-created-in-spanner)); what of your metadata
survives the trip (and what doesn't) is in
[What push and pull preserve](fidelity.md).

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
two entities disconnected (the summary shows `unlinked N orphaned links`). Push
reconciles only the links of the model it is deploying, and an entry group holds
exactly one model, so it never disturbs another model's links.

**When you remove a whole model** — deleting its document does *not* remove it
from the catalog. As long as you still push at least one other model in the same
entry group, push stops and names the model the catalog still has that you no
longer push, so you can't wipe one out by accident or by pushing from the wrong
directory; run push again with `--force-remove` to delete its entries and links.
Deleting *every* document is the exception: with no models left to push, the run
reports `No semantic model documents found; nothing to deploy` and touches
nothing — so remove a model while other models in its group remain, or delete
its catalog entries directly.

Every push prints one line per destination summarizing what it did. For a push
that deploys both the graph and Knowledge Catalog:

```
Deployed 1 BigQuery Graph(s).
Wrote 5 new and 2 updated Knowledge Catalog entries; removed 1 orphaned entry; linked 2 relationships; unlinked 1 orphaned link.
```

A Spanner-targeting model prints `Deployed 1 Spanner Graph(s).` in place of the
BigQuery line.

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
The `--dry-run` and `--force-remove` flags are in
[Reference → pull flags](reference.md#pull).

An entry group holds **exactly one** semantic model. Pull reconstructs that one
model's document; a group with more than one `semantic-model` anchor is an
unexpected state, so pull stops and names the anchors rather than guess which to
keep.

Pull overwrites a model that already exists locally in place. If the catalog's
model has a **different name** than the one on disk, writing it would leave the
entry group holding two models — so by default pull stops and reports the
mismatch instead of deleting anything. Re-run with `--force-remove` to delete the
local model and replace it with the catalog's. Pull never touches BigQuery.

Pull can only return what push wrote, so a push→pull round trip is **not** an
identity — see [What push and pull preserve](fidelity.md) for exactly what
comes back, what comes back normalized, and what doesn't come back at all. Keep
your authored document as the source of truth.

## Importing an OWL ontology

Already have an OWL ontology? `kcmd owl import` converts it into a semantic model
once — classes → entities, object properties → relationships, datatype
properties → fields. The converted model is **unbound** (placeholder sources, no
deployment target), so bind each entity's `source`, fill the relationship join
columns, and add a deployment target before `kcmd push` will deploy it — then it
rides the normal push / pull above. See [Importing an OWL ontology](owl-import.md).
