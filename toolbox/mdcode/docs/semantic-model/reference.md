# Reference

Lookup companion to the [deploy guide](README.md): every flag, exactly what push
creates in each destination, the validation checks, and the permissions each leg
needs. For what of your metadata survives a deploy or a pull, see
[What push and pull preserve](fidelity.md).

## CLI flags

### init

```bash
kcmd init --semantic-model <projectId>.<locationId>.<entryGroupId>
```

Provisions the Knowledge Catalog entry group named by the scope (idempotent — an
existing group is fine) and creates its local directory,
`catalog/EntryGroups/<entryGroupId>/`. Author `<model>.yaml` there.

### push

```bash
kcmd push
```

With no flags, deploys to every destination, BigQuery first.

| Flag | Effect |
|------|--------|
| `--target <bq\|kc\|all>` | Which destination(s) to deploy to; accepts a comma-separated list (`bq,kc`). Default `all`. |
| `--validate-only` | Run every validation check and report pass/fail, but write nothing. |
| `--print` | Print each destination's generated artifact (BigQuery DDL, Knowledge Catalog entry plan). Combine with `--validate-only` to preview without deploying. |
| `--force-remove` | Delete models in the entry group that this push no longer includes (see [Updating and removing models](README.md#updating-and-removing-models)). |
| `--emit-expressions` | Also write the SQL-expression fields (per-field `schema.semantics` and `semantic-metric.expression`) to Knowledge Catalog. Off by default: the published system-type templates do not carry them yet. Knowledge Catalog push only. |

Destinations always deploy BigQuery-first and fail fast, so a rejected model
never half-deploys.

### pull

```bash
kcmd pull
```

Reconstructs the local model document from the Knowledge Catalog entries. Reads
only from Knowledge Catalog (never BigQuery); its coordinates come from the same
scope you authored under. See [Pull](README.md#pull) for behavior.

| Flag | Effect |
|------|--------|
| `--dry-run` | Reconstruct from the catalog and report what would be written, but write no files. |
| `--force-remove` | Replace a differently-named local model with the catalog's (see [Pull](README.md#pull)); without it, a pull that would leave the entry group holding two models fails. |

## What gets created in BigQuery

`push` executes a single `CREATE OR REPLACE PROPERTY GRAPH` per deployment
target, in the project and dataset the target names. Each part of your model
becomes one part of that graph:

| Model element | BigQuery construct | Notes |
|---|---|---|
| Model | `PROPERTY GRAPH` | named by the deployment-target URI |
| Entity | `NODE TABLE` | backed by the entity's `source` table, keyed by its primary key |
| Relationship | `EDGE TABLE` | connects the two entities' node tables |
| Metric | `MEASURE` on a node table | must resolve to a single entity (otherwise the push is rejected — see [Validation](#validation)) and reduce to one supported aggregate over one operand (otherwise that metric is skipped with a warning) |
| Entity `extends` | extra `LABEL` clauses on the subclass node table | the subclass also matches its supertypes; the supertypes' fields flatten down (see [Class hierarchies](#class-hierarchies-extends--labels)) |

`push` reads the target dataset's location (`bigquery.datasets.get`) so the
statement runs in the right region; without that permission it falls back to
BigQuery's own location inference and warns. Under `--validate-only` no graph
DDL is executed and nothing is written (the live source-table checks still run —
see [Validation](#validation)); add `--print` to see the generated DDL.

For which of your descriptive metadata (`description`, `ai_context`, field
labels, …) lands in the graph and which is dropped, see
[What push and pull preserve](fidelity.md#to-bigquery).

### Class hierarchies (`extends` → labels)

An entity that declares `extends: [Parent]` is a **subclass**. BigQuery Graph has
no inheritance keyword, so the push expresses the hierarchy with **labels**: a
subclass node table declares its own default label **plus one `LABEL <Ancestor>`
per supertype**, walking the full transitive chain. A node then matches its
supertype in a query — `MATCH (:Person)` returns `Person`, `Customer`,
`Employee`, and `Manager` nodes alike.

You author only each entity's **own** fields plus the one `extends` keyword; the
push does the rest:

```yaml
datasets:
  - name: Person
    source: proj.ds.person
    primary_key: [id]
    fields:
      - {name: id,        expression: {dialects: [{dialect: BIGQUERY, expression: id}]}}
      - {name: full_name, expression: {dialects: [{dialect: BIGQUERY, expression: full_name}]}}
      - {name: email,     expression: {dialects: [{dialect: BIGQUERY, expression: email}]}}
  - name: Customer
    source: proj.ds.customer
    primary_key: [id]          # each subclass keeps its OWN key; keys do not inherit
    extends: [Person]          # the one keyword you add
    fields:
      - {name: loyalty_tier, expression: {dialects: [{dialect: BIGQUERY, expression: loyalty_tier}]}}
```

For those shared labels to work, **the supertype's fields flatten down** onto the
subclass. BigQuery requires every table exposing a label to expose the **same
property signature**, so a subclass's `LABEL Person` block must list exactly what
`Person`'s own table lists. The push copies each ancestor's fields onto the
subclass (a nearer definition wins on a name clash) so those signatures line up,
and the subclass's default label carries the inherited fields too:

```sql
`proj.ds.customer` AS Customer
  KEY(id)
  DEFAULT LABEL
  PROPERTIES( id, loyalty_tier, full_name, email )   -- own + inherited (flattened)
  LABEL Person
  PROPERTIES( id, full_name, email )                 -- matches Person's own signature
```

```
GRAPH proj.ds.people
MATCH (p:Person) RETURN p.full_name   -- resolves on Customer/Employee/Manager too
```

Four boundaries:

- **Fields flow down; edges and keys do not.** A subclass gains its supertypes'
  fields but **not** their relationships or their key: an edge stays bound to the
  exact node table it was declared on, and each subclass keeps its own `KEY` (a
  node table is identified by its own grain, never its supertype's). If
  `Person —livesIn→ City`, a `Customer` node does not get a `livesIn` edge.
- **The subclass's `source` must physically expose the inherited columns.** The
  flattened `full_name`/`email` above are read from `proj.ds.customer`, so that
  table (or a view over it) must include those columns. Parent and child are
  separate physical tables, so the same real-world entity present in both
  `person` and `customer` appears as two nodes under `MATCH (:Person)` — a
  modeling choice for the binding step, not something the DDL enforces.
- **A shared supertype label carries no OPTIONS and no measures.** A supertype's
  label is bound by every subclass table, and BigQuery forbids a label carried by
  more than one element table from carrying an `OPTIONS` clause or a `MEASURE`. So
  a supertype's own `description`/synonyms are dropped from its label (with a
  warning), and a metric that targets a supertype is skipped (with a warning) —
  attach metrics to a leaf class instead. Subclass and leaf labels are
  unaffected.
- **An inherited field cannot be redefined.** A shared label requires one
  identical definition per property across every table that binds it, so if a
  subclass declares a field of the same name as an inherited one but with a
  different expression, the supertype's definition wins and the subclass's is
  dropped (with a warning). Redeclaring it identically is a harmless no-op.

An entity may also be marked **`abstract: true`** — a conceptual class with no
physical table (so it has no `source` and no key). It produces **no node table**;
it survives only as a `LABEL` on its concrete descendants (its fields still
flatten down so the label's signature is present). An abstract entity that no
concrete entity extends has nothing to attach to and is dropped with a warning.
`abstract` is an explicit marker: an entity left with an unbound `source`
placeholder is treated as a binding error and fails the push, never silently
dropped as if it were table-less. The Knowledge Catalog leg does not
model inheritance today, so an abstract entity has no physical resource to
catalog and is skipped there (with a warning); its concrete subtypes are
published normally.

## What gets created in Knowledge Catalog

Each element of your model maps to one catalog resource. Every resource type
below is a built-in system type under `dataplex-types/global` — push references
them, it never creates them.

| Model element | Catalog resource | Kind | Id |
|---|---|---|---|
| Model | `semantic-model` | entry — anchor / parent of the rest | `<model>` |
| Entity | `semantic-entity` (+ built-in `schema` aspect) | entry | `<model>.entities.<entity>` |
| Metric | `semantic-metric` | entry | `<model>.metrics.<metric>` |
| Relationship | `schema-join` | entry link between the two entity entries | derived from the model and relationship names |

An entity entry carries its columns in the `schema` aspect (name, data type,
description, and any `label` per field), plus the entity's keys and unique keys
(`primaryKey` / `uniqueConstraints`); a `schema-join` link carries the
relationship detail — the paired columns and foreign-key direction — in its
aspect. Any element with `ai_context.instructions` (the model, an entity, or a
metric) also gets a built-in `guidelines` aspect holding that text.

Push to Knowledge Catalog is lossy — the catalog holds metadata, not a full copy
of your model. For exactly what is stored, what is gated behind
`--emit-expressions`, and what is never stored, see
[What push and pull preserve](fidelity.md#to-knowledge-catalog).

## Validation

`push` and `--validate-only` run the same checks, **before either destination is
touched**, so a model that cannot deploy fails fast instead of half-deploying:

* **Exactly one deployment target per model, and it must be a valid BigQuery
  Graph URI.** A model with no target — or with more than one — is rejected, and
  so is a single target whose URI does not match
  `//bigquery.googleapis.com/projects/<p>/datasets/<d>/propertyGraphs/<g>` (for
  example a `propertyGraph`/`propertyGraphs` typo, or a
  `…/entryGroups/@bigquery/entries/…` entry form). The error names the offending
  URI and the expected form. This gate runs before any destination leg and for
  every `--target`, so a malformed target writes **nothing** — not to BigQuery
  and **not to Knowledge Catalog**; the push aborts with a non-zero exit and no
  entries are created. *(static)*
* **Every metric on a BigQuery Graph model resolves to exactly one entity** —
  otherwise it would be dropped from the BigQuery Graph. Set the metric's attach
  entity, or scope its expression to a single entity. *(static)*
* **Every entity's source table is reachable.** Each `source` is probed with a
  dry-run query, so BigQuery resolves it exactly as the deploy will — a
  three-part `project.dataset.table`, a four-part federated REST-catalog name
  (e.g. an Iceberg table via BigLake), or a quoted identifier all work. A table
  that does not exist or that you cannot access fails the push, naming the table
  and the entity; a `source` that is a query (not a table) is skipped. *(live —
  needs BigQuery access)*

The live table check runs for **every** `--target`, because the same tables back
both destinations — so even a Knowledge-Catalog-only push confirms the model
could deploy to BigQuery.

## Permissions

`push` needs access to whichever destinations you deploy to.

**BigQuery** — for `--target bq` or `all`, and for the validation pre-flight:

* `bigquery.jobs.create` in the deployment-target project — to run the deploy's
  `CREATE OR REPLACE PROPERTY GRAPH` and the validation dry-run query
* read access on each entity's source table, so the dry-run can resolve it
* `bigquery.datasets.get` on the target dataset (region detection; optional —
  push degrades gracefully without it)

**Knowledge Catalog / Dataplex** — for `--target kc` or `all`:

* `dataplex.entryGroups.useSemanticModelAspect`,
  `dataplex.entryGroups.useSemanticEntityAspect`, and
  `dataplex.entryGroups.useSemanticMetricAspect` on the destination entry group
* `dataplex.entryGroups.useSchemaAspect` on the destination entry group — every
  entity carries the built-in `schema` aspect (its fields, keys, unique keys,
  and labels)
* `dataplex.entryGroups.useGuidelinesAspect` when any element carries
  `ai_context.instructions` (the model, an entity, or a metric)
* `dataplex.entryGroups.useSchemaJoinEntryLink` and
  `dataplex.entryGroups.useSchemaJoinAspect` when the model has relationships

`kcmd pull` needs read access to the same entry group instead — to list its
entries and fetch each `semantic-*` entry with its aspects.
