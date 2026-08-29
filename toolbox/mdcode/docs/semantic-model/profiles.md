# Binding a model to different sources with profiles

> **Status: proposed.** This page is the design for an upcoming feature, written
> as the user guide first so we can iterate on how it *reads* before building it.
> Nothing here is implemented yet.

One semantic model often has to deploy against more than one physical home: a
dev copy and a prod copy, or two differently-shaped copies of the same data
(for example, one imported from another warehouse). Today a model binds to
exactly one set of tables — each entity's `source`, each field's column, and the
deployment target are all fixed in the model document. A **binding profile** lets
you keep one logical model and swap the physical binding at push time.

A profile is a named, complete physical realization of a model: where each
entity's data lives, which column each field reads, and which graph the model
deploys to. You select one per push with `--profile`; the model's *meaning* —
its entities, fields, metrics, and relationships — is identical no matter which
profile you pick.

## When you need one

| You have… | Use a profile to… |
|---|---|
| A dev, staging, and prod copy with the **same layout** | repoint the sources and deployment target per environment — a few lines each |
| A **differently-shaped copy** (different table and column names) | remap sources *and* columns *and* join keys, while the metrics and labels stay put |

Profiles do **not** change how the model is computed or what it means. They
relocate data; they don't redefine it. Pointing a model at a different
execution engine (say Spanner instead of BigQuery), where the SQL
dialect and deploy mechanism differ, is out of scope for profiles — that's a
separate, larger capability.

## How it works: a base and its overrides

Think of it as a class hierarchy, the same way an entity `extends` a supertype:

- Your **model file** (`<model>.yaml`) is the **base** — a complete model whose
  inline bindings are the profile named `default`. With no profile selected, this
  is what deploys.
- A **profile** is a **subclass**: a document in the *identical schema* as the
  model, with only the parts it changes filled in.
- `kcmd push --profile <name>` **merges** the profile onto the base — matching
  entities, fields, relationships, and metrics **by name** — and deploys the
  merged result. A profile is never deployed alone; base + profile must together
  form a complete, valid model.

Because a profile is just a model document with holes, there's one schema to
learn. Authoring a profile is "copy the model file, delete everything that
doesn't change."

## What a profile may change — the contract

A profile may set only the **physical** facets of a model. Everything else is
owned by the base and is rejected if a profile tries to set it. This is the
guarantee: switching profiles can move the data, but it can never change what the
model means, so `dev` and `prod` always compute the same answer.

| A profile **may** override (physical) | A profile **may not** touch (logical, base-only) |
|---|---|
| the model's `deployment_target` | adding or removing entities, fields, or metrics |
| an entity's `source` | a field's `label`, `description`, `dimension`, `datatype` |
| an entity's `primary_key` / `unique_keys` | any `ai_context` / synonyms |
| a field's column (its `expression`, **as a bare column reference**) | a field `expression` that is arbitrary SQL, which changes the computation rather than the binding |
| a relationship's `from_columns` / `to_columns` | a relationship's `from` / `to` (the shape of the graph) |
| a junction table's `source` / keys / columns | any `metric` definition |

An element's `name` is not "overridden" — it's the key that pairs a profile
element with the base element it refines.

**Why metrics never appear in a profile.** A metric like
`SUM(orders.o_totalprice)` references the field *name* `o_totalprice` rather
than a column. Field names are stable across profiles — only their column bindings
change — so the metric is correct under every profile without being restated.
The contract and the arithmetic line up for free.

## File layout

Profiles live in a directory next to the model, one file per profile. Each file
is a `semantic_model` document carrying only that profile's deltas:

```
catalog/EntryGroups/sales_eg/
  sales.yaml                    # base model + inline `default` binding
  sales.profiles/
    prod.yaml                   # a semantic_model subclass — same schema as sales.yaml
    snowflake_export.yaml
```

One file per profile keeps them isolated: `--profile prod` reads only
`prod.yaml`, so an edit or a typo in `dev.yaml` can never break a prod deploy,
and each profile can be reviewed and owned on its own. The `default` binding
stays inline in `sales.yaml`, so a simple model needs no `sales.profiles/`
directory at all.

## Example 1 — environments (same layout)

The base holds the model and the dev binding:

```yaml
# sales.yaml
version: "0.2.0.dev0"
semantic_model:
  - name: sales
    deployment_target: //bigquery.googleapis.com/projects/acme-dev/datasets/sales/propertyGraphs/sales
    datasets:
      - name: orders
        source: acme-dev.sales.orders
        primary_key: [o_orderkey]
        fields:
          - name: o_orderkey
            expression: {dialects: [{dialect: BIGQUERY, expression: o_orderkey}]}
          - name: o_orderdate
            expression: {dialects: [{dialect: BIGQUERY, expression: o_orderdate}]}
            label: Order Date
            dimension: {is_time: true}
          - name: o_totalprice
            expression: {dialects: [{dialect: BIGQUERY, expression: o_totalprice}]}
      - name: customer
        source: acme-dev.sales.customer
        primary_key: [c_custkey]
        fields:
          - name: c_custkey
            expression: {dialects: [{dialect: BIGQUERY, expression: c_custkey}]}
          - name: c_name
            expression: {dialects: [{dialect: BIGQUERY, expression: c_name}]}
    relationships:
      - name: orders_to_customer
        from: orders
        to: customer
        from_columns: [o_custkey]
        to_columns: [c_custkey]
    metrics:
      - name: total_revenue
        expression: {dialects: [{dialect: BIGQUERY, expression: SUM(orders.o_totalprice)}]}
```

The prod profile changes only the project and the target — everything else is
inherited:

```yaml
# sales.profiles/prod.yaml
version: "0.2.0.dev0"
semantic_model:
  - name: sales
    deployment_target: //bigquery.googleapis.com/projects/acme-prod/datasets/sales/propertyGraphs/sales
    datasets:
      - name: orders
        source: acme-prod.sales.orders
      - name: customer
        source: acme-prod.sales.customer
```

`kcmd push --profile prod` deploys the whole model against `acme-prod`. Columns,
keys, the relationship, and the metric all come from the base.

## Example 2 — a different physical layout

A copy imported from Snowflake: different table names, different column names,
different key columns. The profile overrides down to the column and the join
keys — and the base model above is untouched, so `total_revenue` and the
`Order Date` label still mean what they did.

```yaml
# sales.profiles/snowflake_export.yaml
version: "0.2.0.dev0"
semantic_model:
  - name: sales
    deployment_target: //bigquery.googleapis.com/projects/acme/datasets/sf/propertyGraphs/sales
    datasets:
      - name: orders
        source: sf_import.PUBLIC.ORDERS
        primary_key: [ORDER_KEY]
        fields:
          - name: o_orderkey
            expression: {dialects: [{dialect: BIGQUERY, expression: ORDER_KEY}]}
          - name: o_orderdate
            expression: {dialects: [{dialect: BIGQUERY, expression: ORDER_DATE}]}   # inherits label + dimension
          - name: o_totalprice
            expression: {dialects: [{dialect: BIGQUERY, expression: TOTAL_PRICE}]}
      - name: customer
        source: sf_import.PUBLIC.CUSTOMER
        primary_key: [CUST_KEY]
        fields:
          - name: c_custkey
            expression: {dialects: [{dialect: BIGQUERY, expression: CUST_KEY}]}
          - name: c_name
            expression: {dialects: [{dialect: BIGQUERY, expression: CUST_NAME}]}
    relationships:
      - name: orders_to_customer
        from_columns: [CUST_KEY_FK]
        to_columns: [CUST_KEY]
```

`o_orderdate` flips only its column; it keeps `label: Order Date` and its
time-dimension role from the base. The imported tables live in BigQuery (via
BigLake / a federated catalog) — the model still executes as a BigQuery Graph,
so the SQL dialect is unchanged.

## Merge rules

- `datasets`, `fields`, `relationships`, and `metrics` merge **by `name`**. A
  name present only in the base is inherited unchanged.
- Scalars — `source`, `expression`, `deployment_target` — **replace**.
- Key tuples — `primary_key`, `from_columns`, `to_columns` — **replace as a
  whole**; they are atomic rather than merged element by element.
- Profiles are **override-only**: a profile can refine physical facets of things
  that exist in the base. It cannot add new entities/fields/metrics or delete
  them.

## Command line

```bash
kcmd push                                # the default profile (base as-is)
kcmd push --profile prod                 # merge prod onto base, deploy the result
kcmd push --profile snowflake_export     # deploy over the Snowflake-shaped copy
kcmd push --profile prod --target kc     # profile and destination-type are independent
kcmd profiles                            # list profiles and their resolved deployment target
```

`--profile` chooses **which physical binding**. The existing `--target
bq|kc|all` chooses **which destination type** (BigQuery Graph, Knowledge
Catalog, or both). They are orthogonal — any profile can go to either
destination.

Set the default so a bare `kcmd push` in CI does the right thing, in
`catalog.yaml`:

```yaml
scope: semantic-model.acme.us.sales_eg
default_profile: prod
```

## Validation

Profiles are checked as part of push; `--validate-only` runs the checks and
writes nothing.

- **Unknown profile** — `--profile stg` when `stg` isn't defined fails and lists
  the profiles that are.
- **Missing or ambiguous target** — the merged model must resolve to exactly one
  `deployment_target` (from the base or the profile); zero or more than one is
  rejected.
- **Logical override** — a profile that sets a `label`, `dimension`,
  `ai_context`, a `metric`, a relationship `from`/`to`, or a field `expression`
  that isn't a bare column reference is rejected, naming the offending path.
  Profiles are physical-only.
- **Unknown name** — a profile element whose `name` isn't in the base is
  rejected. Profiles override; they don't add.

## Notes

**The deployment target is now a first-class key.** So a profile can override it
readably, `deployment_target:` moves out of the `GOOGLE custom_extensions` block
and onto the model. The old custom-extension form is still accepted and means
the same thing, so existing models keep working.

**An abstract base.** Validation runs on base + profile, so the base doesn't have
to carry sources at all. A base that omits `source` and `deployment_target` is
effectively abstract: it won't deploy on its own, and *every* profile must supply
the physical bindings. This is the same mechanism as the inline `default`, just
with the base left empty — the same way an entity can be `abstract`.

**Dialect is deferred on purpose.** A profile carries no SQL dialect. The dialect
is a property of the execution backend, which the deployment target implies —
every profile today targets a BigQuery Graph, so there is one dialect and nothing
to choose. When a non-BigQuery execution backend is supported, the dialect will
be derived from that backend (and transpiled) rather than authored per profile, so the
profile schema won't change.
