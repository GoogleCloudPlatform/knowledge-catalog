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

- The **model file** (`<model>.yaml`) is the **base** — the complete
  declaration, whose inline bindings are the profile named `default`.
- A **profile** is a **subclass**: a document in the *identical schema* as the
  model, carrying only the bindings it changes.
- `kcmd push --profile <name>` **merges** the profile onto the base — matching
  entities, fields, relationships, and metrics **by name** — and deploys the
  result. A profile is never deployed alone: the base supplies every
  declaration, and the profile supplies the bindings its store provides.

A profile is a model document with holes, so there is one schema to learn.
Authoring a profile is "copy the model file, keep only the bindings that change."

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

A model separates two things. **Declaration** is logical: which entities,
fields, relationships, and metrics exist, what each means, and how each metric
computes. The base owns all of it. **Binding** is physical: which store each
entity reads from, and which column each field reads. A profile sets binding and
leaves declaration alone.

| A profile **may** set (binding) | A profile **may not** touch (declaration, base-only) |
|---|---|
| an entity's `source` (its store URI) | adding or removing entities, fields, or metrics |
| a field's column (its `expression`, **as a bare column reference**) | a field's `label`, `description`, `dimension`, `datatype` |
| whether a field is bound at all under this profile | any `ai_context` / synonyms |
| an entity's `primary_key` / `unique_keys` | a field `expression` that is arbitrary SQL, which changes the computation rather than the binding |
| a relationship's `from_columns` / `to_columns` | a relationship's `from` / `to` (the shape of the graph) |
| a table-backed relationship's `source` / `keys` | any `metric` definition |
| the deployment target | |

An element's `name` is not overridden — it is the key that pairs a profile
element with the base element it refines.

**Why metrics never appear in a profile.** A metric like
`SUM(OrderedAs.extendedPrice * (1 - OrderedAs.discount))` references field
*names* rather than columns. Field names are stable across profiles — only their
column bindings change — so the metric is correct under every profile where its
fields are bound, without being restated. Where a field it references is not
bound, the metric is unavailable under that profile; the next section explains
why.

## Availability follows the bindings

A store holds what it holds. An operational database keeps a customer's live
credit; a warehouse keeps a modeled lifetime value; neither carries the other's
column. A profile binds whatever subset its store serves, and leaves the rest
unbound.

What a profile can answer is therefore derived from what it binds, by one rule.
**A building block is available under a profile when every field it depends on is
bound there. When any input is unbound, the block is unbound too, and so is
anything built on it.** Availability propagates up the dependency graph from the
fields a profile binds. The chain runs as far as the model does:

- a field is bound when the profile gives its column;
- a metric is available when every field its expression references is bound;
- an action is available when every field it reads or writes is bound;
- a relationship is available when the join columns on both ends are bound, and
  a traversal or cross-entity metric over it is available only when the
  relationship is.

So an operational-only field such as live credit carries its operational-only
metrics and actions with it, and a warehouse-only field such as lifetime value
carries its reports; each is present where its inputs are, and unavailable
everywhere else. The base still declares each thing once; a profile
answers the part of the model its store can back.

**Unbound is not null.** A bound field whose data happens to be empty — a
customer with no phone on file — is null: the field exists and the value is
missing. An unbound field does not exist under that profile at all, and anything
that reads it is unavailable there rather than reading a null. Keeping the two
apart is what lets a query fail against a store that cannot answer it instead of
returning a blank that reads like real data.

**Leaving a field unbound is explicit.** A profile leaves a field unbound in one
of two ways. The base declares the field but gives it no column, so no profile
has it until one binds it. Alternatively, a profile that would otherwise inherit
the base's column sets `unbound: true` on the field to drop it. Silently omitting
a field does neither — an omitted field inherits the base's column, and if that
column is absent from the profile's store, validation fails and names it. So a
forgotten binding is caught, and an intentional non-binding is written down.

## File layout

Profiles live in a directory next to the model, one file per profile. Each file
is a `semantic_model` document carrying only that profile's bindings:

```
catalog/EntryGroups/commerce_eg/
  commerce.yaml                  # base declaration + inline `default` binding
  commerce.profiles/
    operational.yaml             # a semantic_model subclass — same schema as commerce.yaml
    analytics.yaml
```

One file per profile keeps them isolated: `--profile operational` reads only
`operational.yaml`, so an edit to one profile cannot break another, and each
profile can be reviewed and owned on its own. The `default` binding stays inline
in `commerce.yaml`, so a model with a single binding needs no directory.

## Example — an operational and an analytical binding

The base holds the declaration and its analytics binding in BigQuery.
`lifetimeValue` is a warehouse-only field, bound here; `availableCredit` is a
live operational-only field, declared but left unbound (no column):

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
          - { name: key,             expression: c_custkey }
          - { name: name,            expression: c_name, label: Customer Name }
          - { name: lifetimeValue,   expression: c_ltv, label: Lifetime Value }
          - { name: availableCredit, label: Available Credit }
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
      - name: avg_lifetime_value
        expression: AVG(Customer.lifetimeValue)
```

The operational profile points the same model at the live Spanner store. Spanner
holds the same customers under different table and column names, binds the live
`availableCredit`, and does not carry the modeled `lifetimeValue`, so the profile
marks it `unbound`:

```yaml
# commerce.profiles/operational.yaml
version: "0.2.0.dev0"
semantic_model:
  - name: commerce
    deployment_target: //spanner.googleapis.com/projects/acme-ops/instances/prod-us/databases/commerce/propertyGraphs/commerce
    entities:
      - name: Customer
        source: //spanner.googleapis.com/projects/acme-ops/instances/prod-us/databases/commerce/tables/Customer
        primary_key: [CustomerId]
        fields:
          - { name: key,             expression: CustomerId }
          - { name: name,            expression: FullName }
          - { name: availableCredit, expression: AvailableCredit }
          - { name: lifetimeValue,   unbound: true }
      - name: Order
        source: //spanner.googleapis.com/projects/acme-ops/instances/prod-us/databases/commerce/tables/Orders
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

`kcmd push --profile operational` deploys the merged model against Spanner. The
two stores hold different facts, so the profiles answer different parts of the
same model:

- `order_count` depends only on `Order.key`, bound under both profiles, so it is
  available under either.
- `avg_lifetime_value` depends on `Customer.lifetimeValue`. The warehouse binds
  it, so the metric is available analytically; the operational store marks it
  unbound, so the metric is unavailable there.
- `availableCredit` is unbound in the base and bound only operationally, so it —
  and a live credit-limit action written on top of it — is available under the
  operational profile and absent under the analytical one.

`orderDate` flips only its column and keeps its time-dimension role from the
base. `Customer Name` and every metric definition are never restated.

## Merge rules

- `entities`, `fields`, `relationships`, and `metrics` merge **by `name`**. A
  name present only in the base is inherited unchanged.
- Scalars — `source`, `expression`, `deployment_target` — **replace**.
- Key tuples — `primary_key`, `from_columns`, `to_columns` — **replace as a
  whole**; they are atomic rather than merged element by element.
- A field with `unbound: true` in a profile **drops** the base's binding for
  that field under that profile.
- Profiles are **binding-only**: a profile sets physical facets and may leave a
  field unbound. It cannot add or remove entities, fields, or metrics, and
  cannot change what any of them mean.

## Command line

```bash
kcmd push                                 # the default profile (base as-is)
kcmd push --profile operational           # merge operational onto base, deploy the result
kcmd push --profile analytics             # deploy against the analytics warehouse
kcmd push --profile analytics --target kc # profile and destination-type are independent
kcmd profiles                             # list profiles, their resolved sources, and what each cannot answer
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
- **Declaration override** — a profile that sets a `label`, `dimension`,
  `ai_context`, a `metric`, a relationship `from`/`to`, or a field `expression`
  that is not a bare column reference is rejected, naming the offending path.
- **Unknown name** — a profile element whose `name` is not in the base is
  rejected. Profiles refine declarations; they do not add them.
- **Unresolvable column** — a column a profile binds, or inherits from the base,
  that the profile's store does not have fails and names it. This is what turns a
  forgotten binding into a loud error rather than an accidental unbinding.
- **Availability report** — push resolves the dependency graph and reports, per
  profile, each metric, action, and traversal it cannot answer, together with
  the unbound field that stops it. Withheld coverage is stated rather than
  discovered later.

## Notes

**The deployment target is a first-class key.** So a profile can override it
readably, `deployment_target:` is a model key rather than a JSON string inside a
`GOOGLE custom_extensions` block. The custom-extension form is still accepted and
means the same thing.

**Bare-string expressions.** A field's `expression` may be written as a one-line
string (`expression: c_name`) instead of the full per-dialect object. The two
forms mean the same thing and expand to the same wire representation.

**An abstract base.** Validation runs on base + profile, so the base need not
carry sources. A base that omits every `source` and `deployment_target` is
abstract: it declares the model, deploys on its own for nothing, and each profile
supplies the physical bindings. Leaving a single field unbound in the base is the
same idea at field granularity, and both match the `abstract` marker an entity
can already carry.

**Dialect comes from the store.** A profile carries no SQL dialect. The
dialect follows from the store a profile binds to; the engine lowers each
`expression` to that store's query language when it runs. A profile chooses the
data, and the execution engine chooses the dialect.
