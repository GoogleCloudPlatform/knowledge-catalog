# One logical model, many physical bindings

> **Scope.** `kcmd` deploys a merged model to a property graph — **BigQuery
> Graph or Spanner Graph**, whichever the profile's deployment target names — and
> to Knowledge Catalog. A profile may bind an entity to any store — BigQuery,
> Spanner, AlloyDB, a lake table — and `kcmd` merges it and reports its
> availability; a binding to a store with no graph backend yet (AlloyDB, a SaaS
> API, a lake table) is merged and reported, not deployed.

A semantic model describes a business logically — its entities, the
relationships between them, and the metrics over them — independent of where the
data physically lives. A **binding profile** maps that one logical model onto a
concrete set of sources. You keep the model as a single canonical definition and
select a profile per scenario; a profile changes only where each entity reads
from, never what the model means. Because every profile shares one model,
`Customer`, `revenue`, and each relationship mean the same thing whichever
profile serves them.

## Why a model gets more than one binding

The same concept usually lives in more than one system, and a profile binds the
model to one of them. The systems differ along whatever axis matters to you:

- **Different backends for different consumers.** A live operational store —
  AlloyDB, Spanner, a SaaS API — holds the `Customer` an agent reads to check
  current state before it acts, and writes back to. An analytics warehouse such
  as BigQuery holds a copy of that same `Customer`, scaled for reporting, that
  dashboards and conversational-analytics agents read. One profile binds each,
  and every consumer inherits the same metric definitions, so `revenue` is
  computed the same way wherever it is asked.
- **Different environments of one backend.** A dev, staging, and prod copy of one
  store are three profiles that differ only in the project they point at.
- **Different physical layouts.** The same model can bind a table exported to
  files in a lake, an Iceberg copy, or a partner's differently-named schema.

A profile is a named binding, and its meaning is yours to decide; the cases above
only illustrate the range. You author the model once and choose the profile when
you deploy or query.

## How it works: a logical model and its bindings

A model and its profiles form a class hierarchy, the same way an entity
`extends` a supertype:

- The **logical model** (`<model>.yaml`) is the **base**: the complete
  declaration — entities, fields, relationships, metrics, the grain, and the
  graph shape — with no physical binding.
- A **binding profile** is a **subclass**: a document in the *identical schema*
  that supplies the physical facets the logical model leaves open — each entity's
  `source`, each field's column, and the deployment target.
- `kcmd push --profile <name>` **merges** the profile onto the logical model —
  matching entities, fields, relationships, and metrics **by name** — and
  deploys the result. A profile is never deployed alone: the logical model
  supplies every declaration, and the profile supplies the bindings its store
  provides.

Because the two share one schema, a binding may also sit inline in the logical
model as a profile named `default`. The layout on this page keeps the logical
model standalone and each binding in its own file, so the split between logical
and physical is visible on disk.

## Sources are URIs

Each entity names where its data lives with `source`, a URI. A Google Cloud
source is an [AIP-122](https://google.aip.dev/122) resource name —
`//bigquery.googleapis.com/…`, `//spanner.googleapis.com/…`,
`//alloydb.googleapis.com/…` — read with ambient IAM. Anything else is a
`scheme://…` URI, such as an `iceberg://…` table that the deployment manifest
resolves to an endpoint. A profile moves an entity between stores by swapping
this URI, and — when the two stores shape the data differently — the column each
field reads.

How that `source` becomes a table reference in the generated graph depends on
the backend:

* **BigQuery** keeps the source **fully qualified**. The resource name
  `//bigquery.googleapis.com/projects/acme/datasets/commerce/tables/Customer` and
  the plain `acme.commerce.Customer` name the same table, and the graph
  references it as `acme.commerce.Customer` — a BigQuery graph can read tables
  across projects and datasets, so the whole path is kept.
* **Spanner** keeps only the **table name**. The graph and all its tables live in
  the one database the deployment target names, so the source is reduced to its
  last segment: both
  `//spanner.googleapis.com/…/databases/…/tables/Customer` and a dotted
  `acme.commerce.Customer` become the bare table `Customer`.

Either URI form works for either backend, so the same authored `source` can
target both — and a profile can swap it for a differently named table when a
store doesn't line up.

## What a profile may change — the contract

A model separates two things. **Declaration** is logical: which entities,
fields, relationships, and metrics exist, what each means, how each metric
computes, the grain, and the graph shape. The logical model owns all of it.
**Binding** is physical: which store each entity reads from, and which column
each field reads. A profile sets binding and leaves declaration alone.

| A profile **may** set (physical binding) | A profile **may not** touch (logical, in the model) |
|---|---|
| an entity's `source` (its store URI) | which entities, fields, relationships, or metrics exist, and what each means |
| a field's column (its `expression`, a bare column reference) | a field's `label`, `description`, `dimension`, `datatype` |
| whether a field is bound at all under this profile | the grain (`primary_key` / `unique_keys`) and graph shape (`from`/`to`, `from_columns`/`to_columns`) |
| the deployment target | a field `expression` that is arbitrary SQL, which changes the computation; any `metric` definition; any `ai_context` / synonyms; a relationship or its junction `source` |

An element's `name` is not overridden — it is the key that pairs a profile
element with the model element it binds. The grain and the join columns name
*fields* rather than physical columns, so they belong to the logical model; each
field's column is resolved per profile from its `expression`.

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
- an entity is available when its key fields are bound — a graph node must be
  keyed, so an entity whose key is unbound is dropped whole, and every
  relationship and metric that touches it falls with it;
- a metric is available when every field its expression references is bound and
  every entity it spans is available;
- a relationship is available when both endpoint entities are available and the
  join columns on both ends are bound; a cross-entity metric over it is available
  only when the relationship is.

So an operational-only field such as live credit carries its operational-only
metrics with it, and a warehouse-only field such as lifetime value carries its
reports; each is present where its inputs are, and unavailable everywhere else.
The logical model still declares each thing once; a profile answers the part of
it that its store can back.

**Unbound is not null.** A bound field whose data happens to be empty — a
customer with no phone on file — is null: the field exists and the value is
missing. An unbound field does not exist under that profile at all, and anything
that reads it is unavailable there rather than reading a null. Keeping the two
apart is what lets a query fail against a store that cannot answer it instead of
returning a blank that reads like real data.

**Leaving a field unbound is explicit.** A profile leaves a field unbound in one
of two ways. The logical model declares the field, and no profile that omits a
column for it has it until one binds it. Alternatively, a profile that would
otherwise inherit a column sets `unbound: true` on the field to drop it. Silently
omitting a field that another profile binds does neither — the field stays
declared and simply has no column under the omitting profile, which is caught if
a metric needs it. When a BigQuery source table a profile binds is missing or
inaccessible, validation fails and names it (the live source probe is
BigQuery-only; a Spanner source is not probed, so a bad Spanner table surfaces at
deploy instead); a mistyped column name resolves to a real table and so surfaces
at deploy, when the graph backend rejects the generated graph. So a forgotten
binding is caught, and an intentional non-binding is written down.

## File layout

A binding may also sit inline in the logical model — logical and physical in a
single file — which is how the `default` profile works, and a model with one
binding needs nothing more. Keeping them in separate files, as below, is one
layout among several: it keeps the logical model reusable across bindings and
lets each binding be reviewed and owned on its own.

The logical model is one file, and its bindings live beside it, one file per
profile:

```
catalog/EntryGroups/commerce_eg/
  commerce.yaml                  # the logical model — declarations only, no bindings
  commerce.profiles/
    analytical.yaml              # bindings for the analytics warehouse
    operational.yaml             # bindings for the operational store
```

Each binding file is a `semantic_model` document in the same schema as the
logical model, carrying only physical facets. `--profile analytical` reads
`commerce.yaml` plus `analytical.yaml`, so nothing in one binding can affect
another.

## Example — one model, an analytical and an operational binding

The logical model declares the business and nothing physical: no sources, no
columns, no deployment target. `lifetimeValue` and `availableCredit` are both
declared here, though no single store carries both:

```yaml
# commerce.yaml — logical model
version: "0.2.0.dev0"
semantic_model:
  - name: commerce
    entities:
      - name: Customer
        primary_key: [key]
        fields:
          - { name: key,             label: Customer ID }
          - { name: name,            label: Customer Name }
          - { name: lifetimeValue,   label: Lifetime Value }
          - { name: availableCredit, label: Available Credit }
      - name: Order
        primary_key: [key]
        fields:
          - { name: key }
          - { name: customerKey }
          - { name: orderDate, dimension: {is_time: true} }
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

The analytical binding points the model at the BigQuery warehouse. The warehouse
carries the modeled `lifetimeValue` and does not hold live credit, so
`availableCredit` is `unbound`:

```yaml
# commerce.profiles/analytical.yaml — BigQuery bindings
version: "0.2.0.dev0"
semantic_model:
  - name: commerce
    deployment_target: //bigquery.googleapis.com/projects/acme-analytics/datasets/sales/propertyGraphs/commerce
    entities:
      - name: Customer
        source: //bigquery.googleapis.com/projects/acme-analytics/datasets/sales/tables/customer
        fields:
          - { name: key,             expression: c_custkey }
          - { name: name,            expression: c_name }
          - { name: lifetimeValue,   expression: c_ltv }
          - { name: availableCredit, unbound: true }
      - name: Order
        source: //bigquery.googleapis.com/projects/acme-analytics/datasets/sales/tables/orders
        fields:
          - { name: key,         expression: o_orderkey }
          - { name: customerKey, expression: o_custkey }
          - { name: orderDate,   expression: o_orderdate }
```

The operational binding points the same model at the live Spanner store. Spanner
holds the same customers under different table and column names, binds the live
`availableCredit`, and does not carry the modeled `lifetimeValue`:

```yaml
# commerce.profiles/operational.yaml — Spanner bindings
version: "0.2.0.dev0"
semantic_model:
  - name: commerce
    deployment_target: //spanner.googleapis.com/projects/acme-ops/instances/prod-us/databases/commerce/propertyGraphs/commerce
    entities:
      - name: Customer
        source: //spanner.googleapis.com/projects/acme-ops/instances/prod-us/databases/commerce/tables/Customer
        fields:
          - { name: key,             expression: CustomerId }
          - { name: name,            expression: FullName }
          - { name: availableCredit, expression: AvailableCredit }
          - { name: lifetimeValue,   unbound: true }
      - name: Order
        source: //spanner.googleapis.com/projects/acme-ops/instances/prod-us/databases/commerce/tables/Orders
        fields:
          - { name: key,         expression: OrderId }
          - { name: customerKey, expression: CustomerId }
          - { name: orderDate,   expression: OrderDate }
```

Neither binding restates the grain, the `PlacedBy` relationship, the labels, or
the metric definitions; those live once in the logical model. `kcmd push
--profile analytical` deploys to BigQuery Graph and `kcmd push --profile
operational` deploys to Spanner Graph — each profile routes to the backend its
deployment target names (see **Scope** above); on Spanner the metrics are
dropped, since Spanner Graph has no `MEASURE`. The two bindings answer different
parts of the same model:

- `order_count` depends only on `Order.key`, bound under both bindings, so it is
  available under either.
- `avg_lifetime_value` depends on `Customer.lifetimeValue`. The warehouse binds
  it, so the metric is available analytically; the operational store marks it
  unbound, so the metric is unavailable there.
- `availableCredit` is bound only operationally, so it — and any metric written
  on top of it — is available under the operational binding and absent under the
  analytical one.

## Merge rules

- A profile carries only `entities` (its alias `datasets` also works) and their
  `fields`; these merge onto the logical model **by `name`**. A profile never
  carries a `relationship` or a `metric` — those are logical, so they live once
  in the model and a profile that sets one is rejected.
- An entity or field named only in the logical model is carried through
  unchanged; a profile element whose `name` is not in the logical model is
  rejected.
- Scalars — `source`, `expression`, `deployment_target` — **replace**.
- A field with `unbound: true` in a profile **drops** any column for that field
  under that profile.
- Profiles are **binding-only**: a profile sets physical facets and may leave a
  field unbound. It cannot add or remove entities, fields, or metrics, change
  the grain or graph shape, or change what anything means.

## Command line

```bash
kcmd push --profile analytical            # merge the analytical bindings and deploy to BigQuery Graph
kcmd push --profile operational           # merge the operational bindings and deploy to Spanner Graph
kcmd push --profile analytical --target kc # profile and destination-type are independent
kcmd push                                 # uses default_profile from catalog.yaml
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
default_profile: analytical
```

## Validation

Profiles are checked as part of push; `--validate-only` runs the checks and
writes nothing.

- **Unknown profile** — `--profile stg` when `stg` is not defined fails and lists
  the profiles that are.
- **Missing or ambiguous target** — a profile that deploys a graph must resolve
  to one `deployment_target`.
- **Declaration override** — a profile that sets a `label`, `dimension`,
  `ai_context`, a `metric`, the grain, a relationship's `from`/`to`, or a field
  `expression` that is not a bare column reference is rejected, naming the
  offending path.
- **Unknown name** — a profile element whose `name` is not in the logical model
  is rejected. Profiles bind declarations; they do not add them.
- **Unresolvable source** — a BigQuery table a profile binds is probed with a
  dry run; a table that is missing or inaccessible fails and names it. The probe
  is BigQuery-only: a Spanner source is not probed, so a bad Spanner table
  surfaces at deploy rather than in validation. Column names are not probed
  either — a mistyped column resolves to a real table and is caught at deploy,
  when the graph backend rejects the generated graph.
- **Availability summary** — push resolves the dependency graph and prints, per
  profile, how many entities, metrics, and relationships the binding leaves
  unavailable. `kcmd profiles` lists each one with the unbound field that stops
  it, so withheld coverage is stated rather than discovered later.

## Notes

**The deployment target is a first-class key.** So a profile can set it readably,
`deployment_target:` is a model key rather than a JSON string inside a `GOOGLE
custom_extensions` block. The custom-extension form is still accepted and means
the same thing.

**Bare-string expressions.** A field's `expression` may be written as a one-line
string (`expression: c_name`) instead of the full per-dialect object. The two
forms mean the same thing and expand to the same wire representation.

**Dialect comes from the store.** A profile carries no SQL dialect. The dialect
follows from the store a profile binds to; the engine lowers each `expression` to
that store's query language when it runs. A profile chooses the data, and the
execution engine chooses the dialect.
