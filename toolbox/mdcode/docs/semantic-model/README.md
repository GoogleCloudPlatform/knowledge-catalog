# Deploying a semantic model

A *semantic model* describes a business logically — its entities, the
relationships between them, and the metrics computed over them — independent of
where the data physically lives. You author it with
[Apache Ossie](https://ossie.apache.org/). `kcmd push` deploys one model two ways
at once:

* **To a data store, where it becomes queryable.** Consumers ask for business
  concepts — `Customer`, `revenue` — and get consistent, model-defined answers
  rather than re-deriving joins and formulas per query. The store can be
  **analytical**, such as BigQuery for reporting and conversational-analytics
  agents, or **operational**, such as Spanner for the live state an agent reads
  before it acts. Which store a model deploys to is set by its
  [deployment target](#where-a-model-deploys-the-deployment-target); the query
  mechanics are in [Reference](reference.md#what-gets-created-in-bigquery).
* **To Knowledge Catalog** — catalog entries and links that make the model
  discoverable as metadata.

Both come from the same source, so a single `push` keeps them in sync and you
never author them separately.

You bind the one logical model to a store with a **binding profile**. A model can
bind to more than one store — an analytical warehouse and an operational database,
say — from a single definition, so `Customer` and `revenue` mean the same thing
wherever they are served. See [Binding profiles](profiles.md).

This page is the deploy walkthrough: author a model, push it, update it, pull it
back. For the Ossie document format itself, see
[ossie.apache.org](https://ossie.apache.org/).

### The rest of the guide

| Page | Open it to… |
|---|---|
| **This page** | author a model and deploy it |
| [Binding profiles](profiles.md) | bind one logical model to several stores |
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
  - name: sales                      # keep equal to the <model>.yaml filename (pull round-trips to that name)
    # Required: where the model deploys. The host of this URI selects the store —
    # BigQuery (analytical) or Spanner (operational).
    deployment_target: //bigquery.googleapis.com/projects/my-project/datasets/sales/propertyGraphs/sales
    entities:                        # each entity is one concept, backed by a table
      - name: orders
        source: //bigquery.googleapis.com/projects/my-project/datasets/sales/tables/orders
        primary_key: [o_orderkey]
        fields:
          - { name: o_orderkey,   expression: o_orderkey }
          - { name: o_totalprice, expression: o_totalprice }
    metrics:
      - name: total_revenue
        expression: SUM(orders.o_totalprice)
```

`deployment_target` and each `source` are resource URIs, and an `expression` may
be a bare column name; the fuller per-dialect and custom-extension forms still
work and mean the same thing. `entities` may also be written `datasets`.

Entities can **extend** other entities (`extends: [Parent]`); push flattens the
supertype's fields down and expresses the hierarchy as BigQuery labels. See
[Class hierarchies](reference.md#class-hierarchies-extends--labels) for the
rules.

### Where a model deploys (the deployment target)

Every model must declare exactly one **deployment target**: where in a store the
model deploys. The host of the target URI selects the store:

```
# BigQuery — an analytical store
//bigquery.googleapis.com/projects/<project>/datasets/<dataset>/propertyGraphs/<name>

# Spanner — an operational store
//spanner.googleapis.com/projects/<project>/instances/<instance>/databases/<database>/propertyGraphs/<name>
```

A BigQuery target names the project and dataset the model deploys into; a Spanner
target names the instance and database. Swapping one target URI for the other
deploys the same model to the other store — the logical model does not change. The
target is also recorded on the model's Knowledge Catalog entry. A model with no
deployment target, or more than one, is rejected at push time (see
[Validation](reference.md#validation)).

For a model that serves more than one store, the target belongs to a
[binding profile](profiles.md) rather than the model. `deployment_target` may
also be written inside a `GOOGLE` custom extension; both forms mean the same
thing.

### Table sources

Each entity's `source` names its backing table, written as a resource URI:
`//bigquery.googleapis.com/…/tables/<table>` for BigQuery,
`//spanner.googleapis.com/…/tables/<table>` for Spanner. A
[binding profile](profiles.md) can move an entity between stores by swapping this
URI.

For BigQuery, a shorthand dotted name also works: `dataset.table` (two parts) is
qualified with the scope's project from `init`, and `project.dataset.table` names
a table in another project. A name with more than three parts — a four-part
`catalog.database.schema.table`, say — points at a table in a **federated REST
catalog**, such as an Apache Iceberg table exposed through BigLake. Validation
resolves the name the same way the deploy does (see
[Validation](reference.md#validation)).

## 2. Push

```bash
kcmd push
```

With no flags this deploys to **every** destination — the store the model's target
names (BigQuery or Spanner) and Knowledge Catalog — the store first. You don't
name the store on the command line; the model's deployment target (or the
[profile](profiles.md) you merge) does. The most common flags:

```bash
kcmd push                      # deploy to the store (default binding) + Knowledge Catalog
kcmd push --no-kc              # deploy only to the store, skip Knowledge Catalog
kcmd push --no-profile         # publish only to Knowledge Catalog, deploy to no store
kcmd push --profile analytical # deploy with one binding profile; its target picks the store
kcmd push --all-profiles       # deploy once per binding profile
kcmd push --validate-only      # run all checks, write nothing
kcmd push --print              # also print the generated DDL / entry plan
```

A push has two axes. The **binding-profile axis** sets how many profiles the model
deploys for: the default binding, `--no-profile` (none — catalog only), a single
`--profile`, or every one with `--all-profiles`. The **Knowledge Catalog axis** is
`--no-kc` (skip the catalog leg). Both default on, so a bare push deploys the
default binding and records to the catalog. See [Binding profiles](profiles.md).

A logical model that declares no deployment target has nowhere to deploy in a
store, so a bare `kcmd push` records it to Knowledge Catalog alone (and `--no-kc`
on such a model is an error — it would have nowhere to go).

See [Reference → push flags](reference.md#push) for the full list. The store leg
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
deployed store by hand. Re-running is safe: each push makes the destinations
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
that deploys to both the store and Knowledge Catalog:

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

Pull reads only from Knowledge Catalog (never the data store). Its coordinates come
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
local model and replace it with the catalog's. Pull never touches the data store.

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
