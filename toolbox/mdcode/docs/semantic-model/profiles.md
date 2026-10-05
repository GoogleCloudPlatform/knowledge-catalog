# One logical model, many physical bindings

> **Scope.** A `deployment_target` answers two questions that are easy to
> conflate: where the model is *published*, and where it *runs*.
>
> `kcmd push` publishes. It deploys a property graph to the backend the target
> names — BigQuery Graph or Spanner Graph — and the logical model to Knowledge
> Catalog, which takes it under any profile.
>
> An action's statements run against whatever store the profile binds. All
> three backends execute SQL DML, so all three can carry a write. What differs
> is the **push**: an AlloyDB target runs and does not push, because AlloyDB has
> no property-graph DDL for a push to deploy, while Spanner and BigQuery do
> both.
>
> A profile's sources take the forms listed under [Sources](#sources). A source
> in any other form is rejected.

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
- **Different physical layouts.** The same model can bind an Iceberg copy read
  through BigLake, or a partner's differently-named schema.

A profile is a named binding, and its meaning is yours to decide; the cases above
only illustrate the range. You author the model once and choose the profile when
you deploy or query.

## How it works: a logical model and its bindings

A model and its profiles form a class hierarchy, the same way an entity
`extends` a supertype:

- The **logical model** (`<model>.yaml`) is the **base**: the complete
  declaration — entities, fields, relationships, metrics, the grain, and the
  graph shape — with no physical binding.
- A **binding profile** is a **subclass**: it supplies the physical facets the
  logical model leaves open, such as each entity's `source` and key columns,
  each field's column, and each relationship's join columns.
- `kcmd push --profile <name>` **merges** the profile onto the logical model —
  matching entities, fields, relationships, and metrics **by name** — and
  deploys the result. A profile is never deployed alone: the logical model
  supplies every declaration, and the profile supplies the bindings its store
  provides.

A binding may also sit inline in the logical model, as the profile named
`default`. The layout on this page keeps the logical
model standalone and each binding in its own file, so the split between logical
and physical is visible on disk.

## Sources

Each entity names where its data lives with `source`. A Google Cloud table is
written as its [AIP-122](https://google.aip.dev/122) resource name, such as
`//bigquery.googleapis.com/…`, `//biglake.googleapis.com/…`,
`//spanner.googleapis.com/…` or `//alloydb.googleapis.com/…`, and is read with
ambient IAM. Any other table is written as its Knowledge Catalog name, under
one of the prefixes `bigquery:`, `spanner:`, `alloydb:`, `cloudsql_mysql:`,
`mysql:`, `cloudsql_postgresql:`, `postgresql:`, `snowflake:` or
`databricks:table:`. A bare table name, a query, and any other prefix are
rejected. The source also fixes the profile's SQL dialect, so every field the
profile binds needs an expression in that dialect or in `ANSI_SQL`.

A profile's sources all sit in one database, meaning the system one query can
reach: all of BigQuery, or one Spanner, AlloyDB or PostgreSQL database, or one
MySQL instance or server, Snowflake account or Databricks metastore. A profile
moves an entity between stores by swapping its source and, when the two stores
shape the data differently, the column each field reads.

## What a profile may change — the contract

A model separates two things. **Declaration** is logical: which entities,
fields, relationships, and metrics exist, what each means, how each metric
computes, the grain, and the graph shape. The logical model owns all of it.
**Binding** is physical: which store each entity reads from, which column each
field reads, and how each action performs its write. A profile sets binding and
leaves declaration alone.

| A profile **may** set (physical binding) | A profile **may not** touch (logical, in the model) |
|---|---|
| an entity's `source` (its store URI) | which entities, fields, relationships, metrics, or actions exist, and what each means |
| a field's column or computation (its `expression`), for a field the entity declares or inherits | a field's `label`, `description`, `dimension`, `datatype` |
| whether a field is bound at all under this profile (`fields_exclude`) | the graph shape (`from`/`to`) and the cardinality a relationship's join columns imply |
| an entity's key columns (`primary_key`, `unique_keys`): restated with the model file's shape where it states keys, and stated alike in every profile where it states none | an entity's key shape once the model file states a key: how many keys and how wide each is |
| a relationship's join columns (`from_columns`, `to_columns`), which every named profile must state itself | |
| an action's `executor` (how the write is performed) | an action's `parameters`, `guards`, and `affects` — what it takes, what gates it, what it changes |
| the deployment target, in the older `<model>.profiles/` layout only | any `metric` definition; any `ai_context` / synonyms; a relationship or its junction `source` |

An element's `name` is not overridden — it is the key that pairs a profile
element with the model element it binds. Key and join columns name physical
columns, not fields, so whether a field is bound says nothing about them; each
field's column is resolved per profile from its `expression`.

**Why an action's executor is a binding.** An action declares what a call does:
its parameters, the constraints that gate it, and the concepts it changes. None
of that changes when the same model is deployed somewhere else. The executor
does, for either of two reasons. An `mcp`, `rest` or `grpc` executor is an
address, and the system it names answers at a different server, endpoint or
method in one environment than in another — nothing about where the data sits
comes into it. A `sql` executor is the statement itself, and each store binds
its own table and column names and speaks its own dialect, so the same write is
a different statement under each binding. Either way the `executor` sits with
`source` and `expression` on the physical side: the same action and the same blast
radius, performed by whatever the binding points at.

The two kinds sit differently in the files, though. An address may be declared
in the model as a default and replaced per profile. A statement has no
model-level spelling at all: **select a named profile whose model declares a
`sql` executor and the command refuses**, naming the action. The single-file
form, where one document is both the model and its binding, is the exception —
its statements already sit beside the columns they name.

**Bindings inherit.** A profile is an overlay: whatever it does not restate
keeps what the model file says. A model may declare one default executor, and a
profile overrides it only for the bindings that perform the write differently —
an action the profile does not mention keeps the default. A field's column works
the same way: a field the profile does not name keeps the model file's column,
if the model binds one, and a field the profile lists in `fields_exclude` is
unbound. That puts one duty on a profile for a store that names columns
differently: restate every field it serves under another name, or exclude it,
because a column inherited into a renamed schema binds to the wrong data and
returns it silently. To withdraw an inherited executor — a read-only binding
that performs no writes at all — a profile writes `executor: null`, which leaves
the action declared and unavailable there.

**Why metrics never appear in a profile.** A metric like
`SUM(OrderedAs.extendedPrice * (1 - OrderedAs.discount))` references field
*names* rather than columns. Field names are stable across profiles — only their
column bindings change — so the metric is correct under every profile where its
fields are bound, without being restated. Where a field it references is not
bound, the profile has to exclude the metric with `metrics_exclude`; the next
section explains why.

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

- a field is bound when the profile, or the model file it inherits from, gives
  its column, and the profile does not exclude it;
- an entity and a relationship are always available: their key and join columns
  are physical columns rather than fields, so unbinding a field never removes
  them;
- a metric is available when every field its expression references is bound and
  the profile does not exclude it; a cross-entity metric also needs a
  relationship connecting its entities;
- an action is available when a binding supplies its `executor`. An action with
  no executor is declared and not performable here.

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

**A profile restates what differs and excludes what its store lacks.** A field
the profile gives an `expression` is bound to it, a field the profile names in
`fields_exclude` is unbound, and every other field keeps what the model file
says. A field the model file leaves unbound has to appear in one of the two
lists: leaving it out of both is an error, not a quiet way to unbind it. The
logical model below binds nothing inline, so the operational profile binds
`availableCredit` and excludes `lifetimeValue`, and the analytical profile does
the reverse. A metric that reaches an excluded field has to be named in the
profile's `metrics_exclude`, and push names each metric that needs it, with the
field it reaches. When the source table a profile binds is missing or
inaccessible, validation fails and names it; a mistyped column name resolves to a
real table and so surfaces at deploy, when BigQuery rejects the generated graph.

## File layout

A binding may also sit inline in the logical model — logical and physical in a
single file — which is how the `default` profile works, and a model with one
binding needs nothing more. Keeping them in separate files, as below, is one
layout among several: it keeps the logical model reusable across bindings and
lets each binding be reviewed and owned on its own.

The logical model is one file, and its bindings live beside it, one file per
profile. A profile file is named after the model and the profile, and holds one
profile:

```
catalog/EntryGroups/commerce_eg/
  commerce.yaml                       # the logical model — declarations only
  commerce.profile.analytical.yaml    # bindings for the analytics warehouse
  commerce.profile.operational.yaml   # bindings for the operational store
```

The `<name>` in the file name must match the `name:` inside the file, and
`default` is reserved for the inline bindings. A profile file carries `name`,
`entities`, `relationships`, `metrics_exclude` and `actions`, and names no
deployment target. A model cannot yet list its deployments, so `kcmd push`
refuses to deploy a graph for a profile file, and says so before it deploys
anything.

The examples on this page use the older layout, which `kcmd push` still
deploys: a `commerce.profiles/` directory whose files are `semantic_model`
documents in the logical model's schema, each carrying only physical facets and
its own `deployment_target`. In either layout, `--profile analytical` reads
`commerce.yaml` plus the analytical profile, so nothing in one binding can
affect another.

## Example — one model, an analytical and an operational binding

The logical model declares the business and nothing physical: no sources, no
columns, no deployment target. `lifetimeValue` and `availableCredit` are both
declared here, though no single store carries both:

```yaml
# commerce.yaml — logical model
version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    entities:
      - name: Customer
        fields:
          - { name: key,             label: Customer ID }
          - { name: name,            label: Customer Name }
          - { name: lifetimeValue,   label: Lifetime Value }
          - { name: availableCredit, label: Available Credit }
      - name: Order
        fields:
          - { name: key, datatype: Integer }
          - { name: customerKey }
          - { name: orderDate, dimension: {is_time: true} }
    relationships:
      - name: PlacedBy
        from: Order
        to: Customer
    metrics:
      - name: order_count
        expression: COUNT(Order.key)
      - name: avg_lifetime_value
        expression: AVG(Customer.lifetimeValue)
    actions:
      - name: CancelOrder
        description: Cancel an order that has not shipped
        parameters:
          - { name: order, concept: Order, field: key }
        affects:
          - { concept: Order, operation: modify }
        # The default: ask the service that owns orders to cancel one. Any
        # binding that does not hold the rows itself uses this.
        executor:
          mcp:
            server: //agentregistry.googleapis.com/projects/acme-ops/locations/us/mcpServers/orders
            tool: cancel_order
```

The analytical binding points the model at the BigQuery warehouse. The warehouse
carries the modeled `lifetimeValue` and does not hold live credit, so
`availableCredit` is excluded: the model binds nothing inline, and this profile
names it in `fields_exclude`. It says nothing about
`CancelOrder`, so the action keeps the default executor: the warehouse reports
on orders but does not own them, and cancelling one means calling the service
that does.

```yaml
# commerce.profiles/analytical.yaml — BigQuery bindings
version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployment_target: //bigquery.googleapis.com/projects/acme-analytics/datasets/sales/propertyGraphs/commerce
    entities:
      - name: Customer
        source: //bigquery.googleapis.com/projects/acme-analytics/datasets/sales/tables/customer
        primary_key: [c_custkey]
        fields:
          - { name: key,             expression: c_custkey }
          - { name: name,            expression: c_name }
          - { name: lifetimeValue,   expression: c_ltv }
        fields_exclude: [availableCredit]    # the warehouse holds no live credit
      - name: Order
        source: //bigquery.googleapis.com/projects/acme-analytics/datasets/sales/tables/orders
        primary_key: [o_orderkey]
        fields:
          - { name: key,         expression: o_orderkey }
          - { name: customerKey, expression: o_custkey }
          - { name: orderDate,   expression: o_orderdate }
    relationships:
      - { name: PlacedBy, from_columns: [o_custkey], to_columns: [c_custkey] }
```

The operational binding points the same model at the live Spanner store. Spanner
holds the same customers under different table and column names, binds the live
`availableCredit`, and excludes the modeled `lifetimeValue`, which it does not
carry. It also owns
the order rows, so it overrides `CancelOrder` to write them directly instead of
calling out:

```yaml
# commerce.profiles/operational.yaml — Spanner bindings
version: "0.2.0.dev0/google"
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
        fields_exclude: [lifetimeValue]      # the live store holds no modeled value
      - name: Order
        source: //spanner.googleapis.com/projects/acme-ops/instances/prod-us/databases/commerce/tables/Orders
        primary_key: [OrderId]
        fields:
          - { name: key,         expression: OrderId }
          - { name: customerKey, expression: CustomerId }
          - { name: orderDate,   expression: OrderDate }
    relationships:
      - { name: PlacedBy, from_columns: [CustomerId], to_columns: [CustomerId] }
    actions:
      - name: CancelOrder
        # Overrides the model's default: this store holds the rows, so the
        # write is DML against them. Only the executor is restated; what the
        # action takes and what it changes stay in the logical model.
        executor:
          sql:
            statements:
              - UPDATE Orders SET Status = 'CANCELLED' WHERE OrderId = @order
    metrics_exclude: "*"                     # Spanner Graph has no measures
```

Each binding states the key columns and the `PlacedBy` join columns in its own
store's column names. Neither changes the key shape, the labels or the metric definitions;
those live once in the logical model. `kcmd push
--profile operational` merges the operational bindings and deploys to their
Spanner backend, while `--profile analytical` deploys to BigQuery — each profile
picks its own backend. The two bindings answer different parts of the same model:

- `order_count` depends only on `Order.key`, so it is available analytically.
  The operational profile deploys to Spanner, whose graphs have no measures, so
  it names every metric in `metrics_exclude` with the wildcard `"*"`.
- `avg_lifetime_value` depends on `Customer.lifetimeValue`. The warehouse binds
  it, so the metric is available analytically. The operational profile excludes
  the field, and a metric that reaches an excluded field has to be named in
  `metrics_exclude`, which the wildcard already does.
- `availableCredit` is bound only operationally, so it — and any metric written
  on top of it — is available under the operational binding and absent under the
  analytical one.
- `CancelOrder` is available under both, and performed differently by each: DML
  operationally, an MCP call analytically. One declaration, one blast radius, two
  mechanisms.

## Merge rules

- A profile carries `entities` with their `source`, key columns, `fields` and
  `fields_exclude`; `relationships` with their `from_columns` and `to_columns`;
  `metrics_exclude`; and `actions` with their `executor`. These merge onto the
  logical model **by `name`**. A profile never declares a relationship or a
  metric: it binds a relationship's join columns and may leave metrics out, and
  anything else about either lives once in the model. An entry that sets
  anything else is rejected.
- A profile entity's `fields` may name a field the entity inherits as well as
  one it declares, and so may its `fields_exclude`. Each applies to this
  entity's table only, so an entity that extends it still has an excluded
  field.
- Every named profile must state each relationship's join columns itself. The
  model file's join columns are the inline binding's, and do not stand in for a
  named profile's.
- An entity or field named only in the logical model keeps its declaration and
  any inline column binding; a profile element whose `name` is not in the
  logical model is rejected.
- Scalars — `source`, `expression`, and `deployment_target` in the older
  layout — **replace**.
- A field the profile does not name **keeps** the model file's binding. A field
  in `fields_exclude` is **unbound** under that profile. There is no `unbound`
  flag; `fields_exclude` is how a field is left unbound, and naming one field in
  both `fields` and `fields_exclude` is rejected.
- An action the profile does not mention **keeps** the model's executor, if it
  declared one, so a model can state one default and a profile override only
  where the write differs;
  `executor: null` withdraws it explicitly. Only an `mcp`, `rest` or `grpc`
  executor may be that default; a `sql` one is rejected in a model the profile
  names, and belongs in the profile itself.
- Profiles are **binding-only**: a profile sets physical facets, may leave a
  field unbound with `fields_exclude`, and may leave metrics out with
  `metrics_exclude`. It cannot add entities, fields or metrics, change the key
  shape or the graph shape, or change what anything means.

## Command line

```bash
kcmd push                                 # deploy the graph with the default binding + Knowledge Catalog
kcmd push --profile analytical            # deploy the graph with the analytical bindings (BigQuery target)
kcmd push --profile operational           # deploy the graph with the operational bindings (Spanner target)
kcmd push --all-profiles                  # deploy the graph once per binding profile
kcmd push --profile analytical --no-kc    # deploy only the graph, skip Knowledge Catalog
kcmd push --no-profile                    # publish only to Knowledge Catalog, deploy no graph
kcmd profiles                             # list profiles, their resolved sources, and what each cannot answer
```

`--profile` chooses **which physical binding** feeds the graph, and that binding's
`deployment_target` selects **which graph backend** the model deploys to
(BigQuery Graph or Spanner Graph). You never name the backend on the command line
— picking the profile is picking the backend. The binding-profile axis (how many
profiles the graph deploys for: `--no-profile`, the default, `--profile`, or
`--all-profiles`) is separate from the **Knowledge Catalog** axis (`--no-kc`).
Both default on; `--no-profile --no-kc` together is an error (nothing to deploy).

**Deploying to more than one binding at once.** `--all-profiles` deploys the graph
once for every defined profile — for example the analytical (BigQuery) and
operational (Spanner) graphs in a single run. Knowledge Catalog still records one
canonical view of the logical model — the default binding — so a bare `kcmd push`
and a `kcmd push --all-profiles` write the same catalog entries and differ only in
how many graphs deploy.

There is always a **default binding profile**: whatever `default_profile` names,
or — if it is unset — the model's inline bindings (the implicit `default`
profile). Because `default` names those inline bindings, it is reserved: a
`<model>.profiles/default.yaml` is rejected rather than silently ignored. Set the
default so a bare `kcmd push` in CI does the right thing, in `catalog.yaml`:

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
  `ai_context`, a `metric`, or a relationship's `from`/`to` is rejected, naming
  the offending path.
- **Unknown name** — a profile element whose `name` is not in the logical model
  is rejected. Profiles bind declarations; they do not add them.
- **Unresolvable source** — the BigQuery table a profile binds is probed with a
  dry run; a table that is missing or inaccessible fails and names it. Column
  names are not probed here — a mistyped column resolves to a real table and is
  caught at deploy, when BigQuery rejects the generated graph.
- **Rejected DML** — where this profile deploys to Spanner or BigQuery, every
  statement in an action's `sql` executor is planned against that store without
  running it, and a store that refuses one fails the push and quotes back why.
  The profile is what picks the store, so the same statement can pass under one
  profile and fail under another. A profile deploying to **AlloyDB** is the
  exception: its statements are checked for shape but never sent anywhere, so
  nothing confirms the names in them. See
  [statements use your database names](actions.md#statements-use-your-database-names).
- **Availability summary** — push resolves the dependency graph and prints, per
  profile, how many fields the binding leaves unbound and how many metrics and
  actions that makes unavailable. Entities and relationships stay available,
  since their key and join columns are physical columns rather than fields. `kcmd profiles` lists each one with the reason that stops
  it, so withheld coverage is stated rather than discovered later. Actions are
  listed apart, under `cannot run:` rather than `cannot answer:`: an action a
  binding drops is not a question it cannot answer, it is a write it cannot
  perform.

## Notes

**The deployment target is a first-class key.** Under the extended
`0.2.0.dev0/google` profile — the version these binding examples use —
`deployment_target:` is a native model key, so a profile in the older layout
sets it readably. The
vanilla `0.2.0.dev0` profile has no native key for it; there the target rides in a
`GOOGLE` `custom_extensions` block instead. The two are the same target written
two ways, chosen by the document's `version` (see [model
spec](model_spec.md#1-status-and-baseline)).

**Bare-string expressions.** A field's `expression` may be written as a one-line
string (`expression: c_name`) instead of the full per-dialect object. The two
forms mean the same thing and expand to the same wire representation.

**Dialect comes from the store.** A profile carries no SQL dialect. The dialect
follows from the store a profile binds to; the engine lowers each `expression` to
that store's query language when it runs. A profile chooses the data, and the
execution engine chooses the dialect.

**An action's statements reach the store as written.** Lowering covers a
field's `expression` and stops there. kcmd passes a `sql` executor's statements
through unchanged, so they name physical tables and columns and use the dialect
of the store the profile binds. `CancelOrder` above writes `UPDATE Orders SET
Status = 'CANCELLED'` rather than the model's `Order` and `key`, and a profile
that binds a different store restates those statements for it.
