# Binding a model to different sources with profiles

> **Status: proposed.** This page is the design for an upcoming feature, written
> as the user guide first so we can iterate on how it reads. Nothing here is
> implemented yet.

A semantic model describes a business logically — its entities, the
relationships between them, and the metrics over them — independent of where the
data physically lives. A **binding profile** maps that one logical model onto a
concrete set of sources. You keep the model as a single canonical definition and
select a profile per scenario; a profile changes only where each entity reads
from, never what the model means. Because every profile shares one model,
`Customer`, `revenue`, and each relationship mean the same thing whichever
profile serves them.

## One model, many stores

The same concept usually lives in more than one system. A `Customer` sits in a
live operational database and in a day-stale analytics warehouse; an `Order` is
written transactionally and reported on in BigQuery. A profile lets one model
serve both kinds of consumer from a single definition:

- **An operational profile** reads from the live operational stores, such as
  AlloyDB or Spanner. An operational agent uses it to check current state before
  it acts — a customer's balance, a part's availability — and write actions run
  against it.
- **An analytical profile** reads from the analytics warehouse, such as
  BigQuery: a copy scaled and shaped for reporting. Dashboards, BI tools, and
  conversational analytics agents read through it, and each inherits the same
  metric definitions, so `revenue` is computed the same way across all of them.

You author the model once and choose the profile when you deploy or query. The
same mechanism also covers a narrower case: a dev, staging, and prod copy of one
store are three profiles that differ only in the project they point at.

## How it works: a base and its overrides

A model and its profiles form a class hierarchy, the same way an entity
`extends` a supertype:

- The **model file** (`<model>.yaml`) is the **base** — a complete model whose
  inline sources are the profile named `default`.
- A **profile** is a **subclass**: a document in the *identical schema* as the
  model, carrying only the parts it changes.
- `kcmd push --profile <name>` **merges** the profile onto the base — matching
  entities, fields, relationships, and metrics **by name** — and deploys the
  result. A profile is never deployed alone; base + profile must together form a
  complete, valid model.

A profile is a model document with holes, so there is one schema to learn.
Authoring a profile is "copy the model file, keep only what changes."

## Sources are URIs

Each entity names where its data lives with `source`, a URI. A Google Cloud
source is an [AIP-122](https://google.aip.dev/122) resource name —
`//bigquery.googleapis.com/…`, `//spanner.googleapis.com/…`,
`//alloydb.googleapis.com/…` — read with ambient IAM. Anything else is a
`scheme://…` URI, such as an `iceberg://…` table that the deployment manifest
resolves to an endpoint. A profile moves an entity between stores by swapping
this URI, and — when the two stores shape the data differently — the column each
field reads.

## What a profile may change — the contract

A profile may set only the **physical** facets of a model. Everything else is
owned by the base and is rejected if a profile sets it. This is the guarantee:
switching profiles moves where the data is read, and can never change what the
model means, so an operational agent and an analytics dashboard compute the same
`revenue`.

| A profile **may** override (physical) | A profile **may not** touch (logical, base-only) |
|---|---|
| an entity's `source` (its store URI) | adding or removing entities, fields, or metrics |
| a field's column (its `expression`, **as a bare column reference**) | a field's `label`, `description`, `dimension`, `datatype` |
| an entity's `primary_key` / `unique_keys` | any `ai_context` / synonyms |
| a relationship's `from_columns` / `to_columns` | a field `expression` that is arbitrary SQL, which changes the computation rather than the binding |
| a table-backed relationship's `source` / `keys` | a relationship's `from` / `to` (the shape of the graph) |
| the deployment target (for a profile that deploys a graph) | any `metric` definition |

An element's `name` is not overridden — it is the key that pairs a profile
element with the base element it refines.

**Why metrics never appear in a profile.** A metric like
`SUM(OrderedAs.extendedPrice * (1 - OrderedAs.discount))` references field
*names* rather than columns. Field names are stable across profiles — only their column
bindings change — so the metric is correct under every profile without being
restated.

## File layout

Profiles live in a directory next to the model, one file per profile. Each file
is a `semantic_model` document carrying only that profile's deltas:

```
catalog/EntryGroups/commerce_eg/
  commerce.yaml                  # base model + inline `default` binding
  commerce.profiles/
    operational.yaml             # a semantic_model subclass — same schema as commerce.yaml
    analytics.yaml
```

One file per profile keeps them isolated: `--profile operational` reads only
`operational.yaml`, so an edit to one profile cannot break another, and each
profile can be reviewed and owned on its own. The `default` binding stays inline
in `commerce.yaml`, so a model with a single binding needs no directory.

## Example — an operational and an analytical binding

The base holds the model and its analytics binding in BigQuery:

```yaml
# commerce.yaml
version: "0.2.0.dev0"
semantic_model:
  - name: commerce
    deployment_target: //bigquery.googleapis.com/projects/acme-analytics/datasets/sales/propertyGraphs/commerce
    entities:
      - name: Customer
        source: //bigquery.googleapis.com/projects/acme-analytics/datasets/sales/tables/customer
        primary_key: [key]
        fields:
          - { name: key,  expression: c_custkey }
          - { name: name, expression: c_name, label: Customer Name }
      - name: Order
        source: //bigquery.googleapis.com/projects/acme-analytics/datasets/sales/tables/orders
        primary_key: [key]
        fields:
          - { name: key,         expression: o_orderkey }
          - { name: customerKey, expression: o_custkey }
          - { name: orderDate,   expression: o_orderdate, dimension: {is_time: true} }
    relationships:
      - name: PlacedBy
        from: Order
        to: Customer
        from_columns: [customerKey]
        to_columns: [key]
    metrics:
      - name: order_count
        expression: COUNT(Order.key)
```

The operational profile points the same model at the live Spanner store. Spanner
holds the same data under different table and column names, so the profile
overrides the sources *and* the columns. The `label: Customer Name`, the time
dimension on `orderDate`, the `PlacedBy` relationship, and the `order_count`
metric all stay in the base:

```yaml
# commerce.profiles/operational.yaml
version: "0.2.0.dev0"
semantic_model:
  - name: commerce
    entities:
      - name: Customer
        source: //spanner.googleapis.com/projects/acme-ops/instances/prod-us/databases/customers/tables/Customer
        primary_key: [CustomerId]
        fields:
          - { name: key,  expression: CustomerId }
          - { name: name, expression: FullName }
      - name: Order
        source: //spanner.googleapis.com/projects/acme-ops/instances/prod-us/databases/orders/tables/Orders
        primary_key: [OrderId]
        fields:
          - { name: key,         expression: OrderId }
          - { name: customerKey, expression: CustomerId }
          - { name: orderDate,   expression: OrderDate }
    relationships:
      - name: PlacedBy
        from_columns: [CustomerId]
        to_columns: [CustomerId]
```

`kcmd push --profile operational` deploys the merged model against Spanner.
`orderDate` flips only its column; it keeps its time-dimension role from the
base. `order_count` and `Customer Name` are never restated.

## Merge rules

- `entities`, `fields`, `relationships`, and `metrics` merge **by `name`**. A
  name present only in the base is inherited unchanged.
- Scalars — `source`, `expression`, `deployment_target` — **replace**.
- Key tuples — `primary_key`, `from_columns`, `to_columns` — **replace as a
  whole**; they are atomic rather than merged element by element.
- Profiles are **override-only**: a profile refines physical facets of things
  that exist in the base. It cannot add new entities, fields, or metrics.

## Command line

```bash
kcmd push                                 # the default profile (base as-is)
kcmd push --profile operational           # merge operational onto base, deploy the result
kcmd push --profile analytics             # deploy against the analytics warehouse
kcmd push --profile analytics --target kc # profile and destination-type are independent
kcmd profiles                             # list profiles and their resolved sources
```

`--profile` chooses **which physical binding**. The existing `--target
bq|kc|all` chooses **which destination type** (BigQuery Graph, Knowledge
Catalog, or both). They are orthogonal — any profile can go to either
destination.

Set the default so a bare `kcmd push` in CI does the right thing, in
`catalog.yaml`:

```yaml
scope: semantic-model.acme.us.commerce_eg
default_profile: analytics
```

## Validation

Profiles are checked as part of push; `--validate-only` runs the checks and
writes nothing.

- **Unknown profile** — `--profile stg` when `stg` is not defined fails and lists
  the profiles that are.
- **Missing or ambiguous target** — a profile that deploys a graph must resolve
  to one `deployment_target` (from the base or the profile).
- **Logical override** — a profile that sets a `label`, `dimension`,
  `ai_context`, a `metric`, a relationship `from`/`to`, or a field `expression`
  that is not a bare column reference is rejected, naming the offending path.
- **Unknown name** — a profile element whose `name` is not in the base is
  rejected. Profiles override; they do not add.

## Partial binding (under consideration)

A store need not serve every attribute of an entity. Under partial binding, a
profile maps whatever subset a source can provide, and attributes it does not
bind resolve to null in that profile. An entity then does not have to bind fully
under every profile — an operational store can expose live balances that the
warehouse lacks, and a warehouse can expose derived attributes the operational
store never stores. This relaxes the rule that base + profile must bind every
field, and is gated on real usage before it ships.

## Notes

**The deployment target is a first-class key.** So a profile can override it
readably, `deployment_target:` is a model key rather than a JSON string inside a
`GOOGLE custom_extensions` block. The custom-extension form is still accepted and
means the same thing.

**Bare-string expressions.** A field's `expression` may be written as a one-line
string (`expression: c_name`) instead of the full per-dialect object. The two
forms mean the same thing and expand to the same wire representation.

**An abstract base.** Validation runs on base + profile, so the base need not
carry sources. A base that omits `source` and `deployment_target` is abstract: it
does not deploy on its own, and every profile supplies the physical bindings.
This is the same mechanism as the inline `default`, with the base left empty, and
matches the `abstract` marker an entity can already carry.

**Dialect comes from the store.** A profile carries no SQL dialect. The
dialect follows from the store a profile binds to; the engine lowers each
`expression` to that store's query language when it runs. A profile chooses the
data, and the execution engine chooses the dialect.
