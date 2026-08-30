# One logical model, many physical bindings

A semantic model describes a business logically — its entities, the relationships
between them, and the metrics over them — independent of where the data
physically lives. A **binding profile** maps that one logical model onto a
concrete set of sources. You author the model once as a single canonical
definition and pick a profile per scenario; a profile changes only *where* each
entity reads from, never *what* the model means, so `Customer`, `revenue`, and
every relationship mean the same thing whichever profile serves them.

It works like a class hierarchy (the same way an entity `extends` a supertype):
the logical model (`<model>.yaml`) is the **base** — the complete declaration of
entities, fields, relationships, metrics, the grain, and the graph shape, with no
physical binding — and each profile is a **subclass** that fills in the facets
the base leaves open: each entity's `source`, each field's column, and the
deployment target. `kcmd push --profile <name>` merges the two **by name** and
deploys the result; a profile is never deployed alone.

> **Scope.** A profile deploys to the graph backend its `deployment_target`
> names — **BigQuery or Spanner**, the two backends today —
> plus Knowledge Catalog. It rebinds sources and columns and may leave fields
> unbound; `kcmd` reports, per profile, what the binding can and cannot answer. A
> store with no graph backend (an operational engine reached another way, a SaaS
> API) is a modeling direction, not a deploy target yet.

## Why a model gets more than one binding

The same concept usually lives in more than one system, and a profile binds the
model to one of them:

- **Different backends for different consumers.** A live operational store
  (Spanner) holds the `Customer` an agent reads and writes as it acts; an
  analytics warehouse (BigQuery) holds a scaled copy the dashboards read. Each is
  a profile, and both inherit the same metric definitions, so `revenue` is
  computed the same way wherever it is asked.
- **Different environments.** Dev, staging, and prod are three profiles that
  differ only in the project they point at.
- **Different layouts.** The same model can bind a table exported to a lake, an
  Iceberg copy, or a partner's differently-named schema.

You author the model once and choose the profile when you deploy or query.

## Walkthrough: one model, two bindings

The logical model is one file, and its bindings live beside it, one file per
profile:

```
catalog/EntryGroups/commerce_eg/
  commerce.yaml                  # the logical model — declarations only, no bindings
  commerce.profiles/
    analytical.yaml              # bindings for the analytics warehouse
    operational.yaml             # bindings for the operational store
```

A binding can also sit inline in the logical model as a profile named `default`;
keeping them in separate files, as here, lets each binding be reviewed and owned
on its own.

The logical model declares the business and nothing physical — no sources, no
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

The **analytical** binding points the model at the BigQuery warehouse. The
warehouse carries the modeled `lifetimeValue` and not live credit, so
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

The **operational** binding points the same model at the live Spanner store.
Spanner holds the same customers under different table and column names, binds the
live `availableCredit`, and does not carry the modeled `lifetimeValue`:

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
the metric definitions — those live once in the logical model. `kcmd push
--profile analytical` deploys to BigQuery Graph and `kcmd push --profile
operational` deploys to Spanner Graph, each routing to the backend its deployment
target names; on Spanner the metrics are dropped, since Spanner Graph has no
`MEASURE`. The two bindings answer different parts of the same model:

- `order_count` depends only on `Order.key`, bound under both, so it is available
  either way.
- `avg_lifetime_value` needs `Customer.lifetimeValue` — the warehouse binds it,
  the operational store marks it `unbound`, so it is available analytically and
  absent operationally.
- `availableCredit`, and any metric on top of it, is available only operationally.

That last effect — a field a store can't back becomes `unbound`, and everything
depending on it becomes unavailable there rather than returning nulls — is the
[availability rule](#availability-what-a-binding-can-answer). The `source` forms
(resource name vs. dotted table name) are in [Source URIs](#source-uris), and the
push flags in [Command line](#command-line).

## What a profile may change — the contract

A profile sets physical **binding** and leaves the logical **declaration** alone:

| Model element | Physical — a profile **may** bind | Logical — a profile **may not** change |
|---|---|---|
| Entity | its `source` (store URI) | that it exists and what it means; its grain (`primary_key` / `unique_keys`) |
| Field | its column — `expression` as a bare column reference; whether it is bound at all | `label`, `description`, `dimension`, `datatype`; an `expression` that is arbitrary SQL (the computation itself) |
| Relationship | — | that it exists; its join columns (`from`/`to`, `from_columns`/`to_columns`); its junction `source` |
| Metric | — | its definition (refers to field *names*, stable across profiles) |
| Deployment target | the target URI | — |
| AI metadata | — | `ai_context`, synonyms |

An element's `name` is never bound — it is the key that pairs a profile's binding
to the model element it applies to. Everything logical is defined in terms of
these names, not physical columns: a metric like `AVG(Customer.lifetimeValue)`,
the grain, and a relationship's join columns all reference *field names*, which
are identical under every profile. A profile changes only the column each name
resolves to. That is why a metric is never restated in a profile: it stays
correct wherever its fields are bound, and simply becomes unavailable under a
profile that leaves one of them unbound.

## Availability: what a binding can answer

A store holds what it holds — an operational database keeps a customer's live
credit, a warehouse keeps a modeled lifetime value, neither carries the other's
column. A profile binds whatever subset its store serves and leaves the rest
unbound. What it can answer follows by one rule:

**A building block is available under a profile when every field it depends on is
bound there. When any input is unbound, the block is unbound too, and so is
anything built on it.**

Availability propagates up the dependency graph, as far as the model runs:

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

## Command line

```bash
kcmd push --profile analytical            # merge the analytical bindings and deploy to BigQuery Graph
kcmd push --profile operational           # merge the operational bindings and deploy to Spanner Graph
kcmd push --profile analytical --target kc # write only Knowledge Catalog, skip the graph
kcmd push                                 # uses default_profile from catalog.yaml
kcmd profiles                             # list profiles, their resolved sources, and what each cannot answer
```

`--profile` chooses **which binding** to merge, and that binding's
`deployment_target` fixes its **backend** — BigQuery for the
analytical binding above, Spanner for the operational one. `--target`
chooses **which destinations to write**: `bq`, `spanner`, `kc`, or `all` (the
default). The two are not interchangeable. `--target kc` writes only the catalog
under any profile, but naming a graph leg the profile does not target — say
`--target bq` on the Spanner-bound `operational` — is an error, not a redirect:
the backend is set by the profile's target, never by the flag.

Set the default so a bare `kcmd push` in CI does the right thing, in
`catalog.yaml`:

```yaml
scope: semantic-model.acme.us.commerce_eg
default_profile: analytical
```

## Source URIs

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

## Details

**Unbound is not null.** A bound field whose data happens to be empty — a
customer with no phone on file — is null: the field exists and the value is
missing. An unbound field does not exist under that profile at all, and anything
that reads it is unavailable there rather than reading a null. Keeping the two
apart is what lets a query fail against a store that cannot answer it instead of
returning a blank that reads like real data.

**Leaving a field unbound is explicit.** A profile leaves a field unbound in one
of two ways: the logical model declares a field and no profile binds a column for
it, or a profile that would otherwise inherit a column sets `unbound: true` to
drop it. Either way the field stays declared and simply has no column under that
profile, caught if a metric needs it. So a forgotten binding surfaces, and an
intentional non-binding is written down.

**The deployment target is a first-class key.** So a profile can set it readably,
`deployment_target:` is a model key rather than a JSON string inside a `GOOGLE
custom_extensions` block. The custom-extension form is still accepted and means
the same thing.

**Bare-string expressions.** A field's `expression` may be written as a one-line
string (`expression: c_name`) instead of the full per-dialect object. The two
forms mean the same thing and expand to the same wire representation.

**Dialect comes from the store, not the profile.** A profile carries no SQL
dialect. Expressions are GoogleSQL — the language of both BigQuery and
Spanner — and are emitted into the generated graph as written; the optional
`kcmd push --transpile` pass converts vendor SQL to GoogleSQL at push time when a
source was authored in another dialect. A profile chooses the data, and the
backend it targets fixes the dialect.
