# Deploying a semantic model

A *semantic model* describes a business logically — its entities, the
relationships between them, and the metrics computed over them — independent of
where the data physically lives. You author it in a format based on
[Apache Ossie](https://ossie.apache.org/), extended with a first-class deployment
target and binding profiles. `kcmd push` deploys one model to two kinds of
destination at once:

* **Knowledge Catalog, where the model is governed.** It becomes catalog entries —
  one per entity, metric, and the model itself — joined by links for its
  relationships. There it is the single governed definition of the business:
  access-controlled, searchable, and part of the dynamic knowledge graph that gives
  AI agents the semantics and business context to work with your data. Governing
  needs no tables or data, so you can publish a purely logical model before it is
  bound, or govern the model together with its bindings — the catalog serves
  either. `kcmd pull` rebuilds the model files from these entries.
* **A data store, where the model becomes queryable.** Consumers ask for business
  concepts — `Customer`, `revenue` — and get consistent, model-defined answers
  rather than re-deriving joins and formulas per query. The store can be
  **analytical**, such as BigQuery for reporting and conversational-analytics
  agents, or **operational**, such as Spanner for the live state an agent reads
  before it acts. Which store a model deploys to is set by its
  [deployments](#where-a-model-deploys-deployments); the query
  mechanics are in [Reference](reference.md#what-gets-created-in-bigquery).

Both come from the same source, so a single `push` keeps them in sync and you
never author them separately.

You bind the one logical model to a store with a **binding profile**. A model can
bind to more than one store — an analytical warehouse and an operational database,
say — from a single definition, so `Customer` and `revenue` mean the same thing
wherever they are served. See [Binding profiles](profiles.md).

This page is the operation reference: author the logical model, govern it in
Knowledge Catalog, bind it to a store, then update and pull. For a single runnable
example that carries one model through the whole lifecycle, see the
[codelab](codelab.md); for the Ossie document format itself, see
[ossie.apache.org](https://ossie.apache.org/).

### The rest of the guide

| Page | Open it to… |
|---|---|
| **This page** | look up each deploy operation and its rules |
| [Binding profiles](profiles.md) | bind one logical model to several stores |
| [Modeling class hierarchies](inheritance.md) | model subtypes with `extends` so a supertype query gathers them |
| [Codelab: one semantic ontology, one data journey](codelab.md) | see the whole lifecycle: author, govern, hydrate, query |
| [Modeling write operations](actions.md) | declare an action an agent can call, publish it, run it, and derive an agent's tools from the model |
| [Generating an Agent Skill](skills.md) | write a model out as a skill folder an AI agent loads by itself |
| [Reference](reference.md) | look up a flag, what push creates, validation, or permissions |
| [Model specification](model_spec.md) | the normative format: every YAML construct, what's OSI and what's a kcmd extension |
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

## 1. Author the logical model

Create the local layout. The scope is the Knowledge Catalog entry group the
model will be published to, written as `<projectId>.<locationId>.<entryGroupId>`:

```bash
kcmd init --semantic-model my-project.us-central1.my_model
```

`init` provisions that entry group (idempotent — an existing group is fine) and
creates its local directory. Author the model at
`catalog/EntryGroups/<entryGroupId>/<model>.yaml`. The logical model names the
business and nothing physical — the entities, their fields, the relationships
between them, and the metrics computed over them:

```yaml
version: "0.2.0.dev0/google"

semantic_model:
  - name: sales                      # keep equal to the <model>.yaml filename (pull round-trips to that name)
    entities:                        # each entity is one concept
      - name: orders
        primary_key: [order_id]
        fields:
          - { name: order_id,   datatype: Integer }
          - { name: net_amount, datatype: Decimal }
      - name: customer
        primary_key: [customer_id]
        fields:
          - { name: customer_id, datatype: Integer }
          - { name: name,        datatype: String }
    relationships:
      - name: placed_by
        from: orders
        to: customer
        from_columns: [customer_id]
        to_columns: [customer_id]
    metrics:
      - name: revenue
        expression: SUM(orders.net_amount)
```

Field and relationship names are the business vocabulary — `order_id`,
`placed_by` — never physical column names; the physical binding comes later. A
metric's `expression` may be a bare formula over the logical fields or the fuller
per-dialect form. `entities` may also be written `datasets` (the two are interchangeable under the `/google` version).

Entities can **extend** other entities (`extends: [Parent]`); push flattens the
supertype's fields down and expresses the hierarchy as graph labels, so a query
against the supertype gathers every subtype. See
[Modeling class hierarchies](inheritance.md) to model one step by step, and
[Class hierarchies](reference.md#class-hierarchies-extends--labels) for the rules
push enforces.

A model can also declare **actions**: model-level write operations, the
write-side counterpart to a metric. An action names a business operation, points
at the executor that carries it out (an MCP tool, a REST endpoint, a gRPC
method, or the write itself as DML), and types each parameter against the
ontology: a parameter carries one scalar value, and it either projects a field
— naming the `concept` and `field` it takes its datatype and its wording from —
or declares a scalar `type` of its own. The executor is a physical binding, so a
[binding profile](profiles.md) can supply a different one per store — and DML,
which names one store's own tables, belongs with that store's binding. An action
also names, in `guards`, the constraints that gate it, and in `affects`, the
concepts the call changes — an executor in another system is an opaque handle,
so its blast radius is declared or it is unknown. Knowledge Catalog is the only
system an action is published to, and the only place it is governed; an action
that carries its own DML is also the one kind the runtime executes directly. See
[Modeling write operations](actions.md).

A model can also state **constraints**: named invariants over the ontology that
hold for every instance, whatever writes to the model. A constraint is part of
what the model asserts, and "an account's balance never goes negative" is as
much a fact about an account as the fields beside it. Each one states its rule
in words, under `judgment`, with the field names it mentions written
model-qualified so they are checked like any other reference — which is what
lets a rule no arithmetic decides, such as whether a discount is justified by
the reason given, be stated at all. A constraint does nothing until an action
names it in `guards`; then it is settled before that call runs, by a language
model reading the attempted call. A constraint reaches Knowledge Catalog only:
it is validated, published there, and read back by `pull`.

This model names no table and no store, so it is complete enough to govern in
Knowledge Catalog as-is (step 2). Where each entity reads from — the store and the
columns — is a binding you add in step 3.

## 2. Govern it in Knowledge Catalog

The logical model is complete enough to govern right now, with no tables, no data,
and no store. A model that declares no deployment target has nowhere to deploy in a
store, so a bare `kcmd push` writes it to Knowledge Catalog alone:

```bash
kcmd push --validate-only --print   # preview the entries and links, write nothing
kcmd push                           # write them
```

Push creates an entry for the model itself and for each entity, metric and
relationship. A `semantic-link` joins each pair of related entities, and two
`reference` links join each relationship's entry to its two entities:

```
Wrote 5 new and 0 updated Knowledge Catalog entries; wrote 3 entry links.
```

Push rejects a relationship from an entity to itself, and relationships in
both directions between two entities.

Those entries are the single governed definition of the business. They are
access-controlled, searchable, and joined into the dynamic knowledge graph that
gives AI agents the semantics and business context to reason over your data.
`kcmd pull` rebuilds the model file and profile files from them (see
[Pull](#pull)).
Governance works whether the model is purely logical or already bound: govern it
before it has any physical home, or govern the logical model together with its
bindings. Every store you bind it to later serves this one definition.

> Writing these entries needs the `semantic-model` / `semantic-entity` /
> `semantic-metric` / `semantic-relationship` entry types and write access to
> the entry group. See
> [Permissions](reference.md#permissions).

## 3. Bind and deploy to a store

To make the model queryable, bind it to a store: name where each entity reads
from, which column each field maps to, and which store the model deploys to. You
can put these bindings directly on the model, or keep them in a separate **binding
profile** (`<model>.profile.<name>.yaml`) so one logical model serves several
stores. See [Binding profiles](profiles.md); for a runnable end-to-end that
binds the same model to BigQuery and Spanner and queries each, see the
[codelab](codelab.md).

Once the model declares `deployments`, `kcmd push` publishes to Knowledge
Catalog and deploys each selected deployment to the store its `target` names.
The most common flags:

```bash
kcmd push                         # publish to Knowledge Catalog + deploy every deployment in deployments
kcmd push --deployment analytical # publish to Knowledge Catalog + deploy only the analytical deployment
kcmd push --no-deployment         # publish only to Knowledge Catalog, deploy to no store
kcmd push --validate-only         # run all checks, write nothing
kcmd push --print                 # also print the generated DDL / entry plan
```

You never name the store on the command line; each entry in `deployments` names
its `target` and optional `profile`. The checks that gate a push are in
[Validation](reference.md#validation), and the full flag list is in
[Reference → push](reference.md#push), with the order of push's checks and writes.

### Where a model deploys (`deployments`)

A bound model declares its **deployments** in `deployments`: each entry names
where in a store that deployment lands (`target`), written as its GCP resource
name, and optionally which binding `profile` it uses. The target's host selects
the store:

```
# BigQuery — an analytical store
bigquery.googleapis.com/projects/<project>/datasets/<dataset>/propertyGraphs/<name>

# Spanner — an operational store
spanner.googleapis.com/projects/<project>/instances/<instance>/databases/<database>/graphs/<name>

# AlloyDB — an operational runtime store (no property-graph DDL deployed on push)
alloydb.googleapis.com/projects/<project>/locations/<location>/clusters/<cluster>/databases/<database>
```

A BigQuery target names the project and dataset the model deploys into; a Spanner
target names the instance and database. Swapping one target for the other
deploys the same model to the other store, and listing both deploys it to both.
The logical model does not change. The deployments
are also recorded on the model's Knowledge Catalog entry. Two deployments in the
same model that name the same target are rejected at load time (see
[Validation](reference.md#validation)).

`deployments:` is a native model key under the extended `0.2.0.dev0/google`
flavor; under vanilla Ossie (`0.2.0.dev0`) the same list is written inside a
`GOOGLE` custom extension instead (see
[model spec §6](model_spec.md#6-the-extension-mechanism)). A vanilla model also
binds every source, field expression and join column inline.
[A complete vanilla model](model_spec.md#appendix-a-complete-vanilla-model)
shows both.

### Table sources

Each entity's `source` names its backing table, written as its GCP resource name:
`bigquery.googleapis.com/…/tables/<table>` for BigQuery,
`spanner.googleapis.com/…/tables/<table>` for Spanner. A
[binding profile](profiles.md) can move an entity between stores by swapping this
name.

A table in a **federated REST catalog**, such as an Apache Iceberg table exposed
through BigLake, is written as its BigLake resource name,
`biglake.googleapis.com/projects/<p>/catalogs/<c>/namespaces/<n>/tables/<t>`.
A table in a BigLake Hive catalog is written with `databases/<d>` in place of
`namespaces/<n>`.
Validation resolves each name the same way the deploy does (see
[Validation](reference.md#validation)), and [profiles.md](profiles.md#sources)
lists every accepted store.

### What push creates

In **BigQuery**, a single `CREATE OR REPLACE PROPERTY GRAPH` per deployment
target: each entity becomes a node table, each relationship an edge table, each
metric a measure. In **Spanner**, the same `CREATE OR REPLACE PROPERTY GRAPH` with
bare table names and no measures — Spanner has no `MEASURE`, so a Spanner
deployment uses a profile that excludes every metric, and push rejects one that
leaves a metric available. In **Knowledge Catalog**, one entry per model, entity,
metric and relationship, plus the `semantic-link` and `reference` links that
join them. The exact mapping — and
the class-hierarchy handling — is in
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

**When you rename or delete a relationship** — push removes orphaned and stale
relationship links before writing the current ones, so a renamed or re-pointed
relationship can be created without colliding with the old link (the summary
shows `unlinked N orphaned links`). Push reconciles only the links of the model
it is deploying, and an entry group holds exactly one model, so it never
disturbs another model's links.

**When you remove a whole model** — deleting its document does *not* remove it
from the catalog. As long as you still push at least one other model in the same
entry group, push stops and names the model the catalog still has that you no
longer push, so you can't wipe one out by accident or by pushing from the wrong
directory; run push again with `--force-remove` to delete its entries and links.
That push deletes the old model entry first, and Dataplex deletes the model's
other entries and its links with it. A push that stops partway then leaves the
whole old model or none of it.
Deleting *every* document is the exception: with no models left to push, the run
reports `No semantic model documents found; nothing to deploy` and touches
nothing — so remove a model while other models in its group remain, or delete
its catalog entries directly.

Every push prints one line per destination summarizing what it did. For a push
that deploys to both the store and Knowledge Catalog:

```
Wrote 5 new and 2 updated Knowledge Catalog entries; removed 1 orphaned entry; wrote 3 entry links; unlinked 1 orphaned link.
Deployed 1 BigQuery Graph(s).
```

A Spanner-targeting model prints `Deployed 1 Spanner Graph(s).` in place of the
BigQuery line.

Push sends no request for an entry link that the catalog already holds with the
same two entries and the same aspect data. The summary counts those links in
parentheses, so a push that changes no link prints
`wrote 0 entry links (3 unchanged)`.

## Pull

`kcmd pull` is the inverse of push's Knowledge Catalog leg: it rebuilds the
model file and profile files from the `semantic-*` entries and writes them to
`catalog/EntryGroups/<entryGroupId>/`. Pull changes a local model or profile
file only where the catalog differs from it: every other value keeps its text,
comments, key order and formatting. A changed string keeps its quoting or block
style, and other changed values are written in pull's form. When the catalog
reorders a list whose order counts, such as an entity's fields, an item that
moves, or an item it moves past, can be written in pull's form too. The JSON
`data` of a GOOGLE block, which holds a vanilla model's deployments and
profiles, changes the same way and keeps its layout. When that `data` would
then not hold what the catalog holds, it comes back as the catalog holds it,
and the rest of the file still changes only where it differs. Another
vendor's `data` comes back as the catalog holds it. Pull writes a file whole
when there is no local file, and when it cannot change only those values. When
a local file does not load, pull warns and writes it from the catalog. Use pull
to recover a workspace from a catalog someone else deployed, or to see what the
catalog actually holds.

```bash
kcmd pull
```

Pull reads only from Knowledge Catalog (never the data store). Its coordinates come
from the same scope you authored under (`<projectId>.<locationId>.<entryGroupId>`).
The `--dry-run` and `--force-remove` flags are in
[Reference → pull flags](reference.md#pull).

An entry group holds **exactly one** semantic model. Pull returns that one
model's files; a group with more than one `semantic-model` anchor is an
unexpected state, so pull stops and names the anchors rather than guess which to
keep.

For a model an older `kcmd` pushed, pull writes nothing and warns. Push that
model again with the current `kcmd`.

Pull overwrites a model that already exists locally in place. If the catalog's
model has a **different name** than the one on disk, writing it would leave the
entry group holding two models — so by default pull stops and reports the
mismatch instead of deleting anything. Re-run with `--force-remove` to delete the
local model and replace it with the catalog's. Pull never touches the data store.

Every push sets the `kcmd-push-state` label of the model entry to `writing` when
it writes the model entry, before the model's other entries, and to `finished`
with its last write, after it deletes what the model no longer has. Pull
refuses a model entry still labeled `writing`: it writes and deletes nothing and
asks you to push again. A model with no such label, such as one an older `kcmd`
pushed, counts as finished.

Pull cannot catch a push that stopped before it changed the model entry. The
catalog then still holds what the previous push left, and pull returns that.
With `--force-remove`, a push that stopped while it removed the old model can
leave no model, and pull then finds nothing to pull. After a failed push, push
again before you pull.

The rebuild is **not** an identity
— see [What push and pull preserve](fidelity.md) for exactly what comes back,
what comes back normalized, and what doesn't come back at all.

## Importing an OWL ontology

Already have an OWL ontology? `kcmd owl import` converts it into a semantic model
once — classes → entities, object properties → relationships, datatype
properties → fields. The converted model is **unbound** (no sources, no
deployment target), so bind each entity's `source`, fill the relationship join
columns, and add a deployment target before `kcmd push` will deploy it — then it
rides the normal push / pull above. See [Importing an OWL ontology](owl-import.md).
