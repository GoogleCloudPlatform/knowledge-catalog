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

With no flags, deploys to every destination — the model's graph backend and
Knowledge Catalog — the graph first. You do not choose the graph backend: each
model deploys to whichever its deployment target names (BigQuery Graph or Spanner
Graph). The binding profile selects which physical binding feeds the graph, and
that binding's deployment target selects the backend.

A push has two axes, both defaulted so a bare `kcmd push` deploys the graph for
the default binding and records to Knowledge Catalog. The **binding-profile axis**
sets how many profiles the graph deploys for; the **Knowledge Catalog axis** is
whether the catalog leg runs.

| Flag | Effect |
|------|--------|
| `--profile <name>` | Deploy the graph for one binding profile (`<model>.profiles/<name>.yaml`); its deployment target selects the backend. Defaults to `default_profile` from `catalog.yaml`, else the model's inline bindings. Mutually exclusive with `--all-profiles` and `--no-profile`. See [Binding profiles](profiles.md). |
| `--all-profiles` | Deploy the graph for every defined binding profile (plus the inline bindings when the document itself declares a target), instead of a single one. The Knowledge Catalog leg still records one canonical view — the default binding. Mutually exclusive with `--profile` and `--no-profile`. |
| `--no-profile` | Deploy the graph for no binding profile: publish only the logical model to Knowledge Catalog, leaving any deployed graph untouched. |
| `--no-kc` | Skip the Knowledge Catalog metadata push and deploy only the graph the selected profile targets. Knowledge Catalog is pushed by default. A push that deploys no graph (a logical model, or `--no-profile`) can only reach Knowledge Catalog, so `--no-kc` on it is an error, as is `--no-profile --no-kc` (nothing left to deploy). |
| `--validate-only` | Run every validation check and report pass/fail, but write nothing. |
| `--print` | Print each destination's generated artifact (BigQuery or Spanner Graph SQL DDL, Knowledge Catalog entry plan). Combine with `--validate-only` to preview without deploying. |
| `--force-remove` | Delete models in the entry group that this push no longer includes (see [Updating and removing models](README.md#updating-and-removing-models)). |
| `--emit-expressions` | Also write the SQL-expression fields (per-field `schema.semantics` and `semantic-metric.expression`) to Knowledge Catalog. Off by default: the published system-type templates do not carry them yet. Knowledge Catalog push only. |

The graph leg deploys first and fails fast, so a rejected model never
half-deploys.

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

This section is the rules lookup. To model a hierarchy step by step — declaring
it, binding each subtype's table, and keeping supertype counts correct — see
[Modeling class hierarchies](inheritance.md).

An entity that declares `extends: [Parent]` is a **subclass**. BigQuery Graph has
no inheritance keyword, so the push expresses the hierarchy with **labels**: a
subclass node table declares its own default label **plus one `LABEL <Ancestor>`
per supertype**, walking the full transitive chain. A node then matches its
supertype in a query — `MATCH (:Party)` returns every `Customer` and every
`Supplier` node.

You author each entity's **own** fields plus the one `extends` keyword, and the
push flattens the supertype's fields down onto each subclass. The usual
supertype has no table of its own, so mark it `abstract: true`: it has no
`source` and no key, produces no node table, and survives only as a label on its
subtypes.

```yaml
entities:
  - name: Party
    abstract: true             # no table; becomes a label on every subtype
    primary_key: [id]
    fields:
      - { name: id,   datatype: Integer }
      - { name: name, datatype: String }
  - name: Customer
    extends: [Party]           # the one keyword you add
    primary_key: [id]          # each subclass keeps its OWN key; keys do not inherit
    source: proj.ds.customer
    fields:
      - { name: id,   datatype: Integer, expression: c_custkey }
      - { name: name, datatype: String,  expression: c_name }   # the inherited field, bound to this table's column
      - { name: tier, datatype: String,  expression: c_tier }
  - name: Supplier
    extends: [Party]
    primary_key: [id]
    source: proj.ds.supplier
    fields:
      - { name: id,     datatype: Integer, expression: s_suppkey }
      - { name: name,   datatype: String,  expression: s_name }
      - { name: rating, datatype: Integer, expression: s_rating }
```

**The supertype's fields flatten down** onto each subclass. A supertype
contributes its field names to every subclass, ordered own fields first then
inherited, and a nearer definition wins on a name clash. An abstract supertype
binds no columns of its own, so each subtype supplies the column for every
inherited name on its own table — `id` and `name` above are bound on both the
customer and the supplier. A concrete supertype's bound fields flatten straight
down, and a subtype need not repeat them.

**A shared label is reconciled by property name rather than by backing column**
(verified live). Every table that carries `LABEL Party` must expose the same property
names — here `id` and `name` — and each backs them with its own column. So the
push renders each inherited property from the subtype's own binding: `c_name AS
name` on the customer table, `s_name AS name` on the supplier table. A bare-alias
reference such as `PROPERTIES(name)` does not deploy; BigQuery rejects it with
`Unrecognized name: name`.

```sql
`proj.ds.customer` AS Customer
  KEY(c_custkey)
  DEFAULT LABEL
  PROPERTIES( c_custkey AS id, c_name AS name, c_tier AS tier )   -- id and name inherited from Party; tier is Customer's own
  LABEL Party
  PROPERTIES( c_custkey AS id, c_name AS name )                   -- Party's signature, backed by this table's columns
```

```
GRAPH proj.ds.parties
MATCH (p:Party) RETURN p.name   -- resolves on Customer and Supplier alike
```

The boundaries:

- **Fields flow down; edges and keys do not.** A subclass gains its supertypes'
  fields but **not** their relationships or their key: an edge stays bound to the
  exact node table it was declared on, and each subclass keeps its own `KEY` (a
  node table is identified by its own grain, never its supertype's). If
  `Person —livesIn→ City`, a `Customer` node does not get a `livesIn` edge.
- **The subclass's `source` must physically expose every inherited column.** The
  flattened `name` above is read from `proj.ds.customer`, so that table (or a view
  over it) must include the column that `Customer`'s `name` field binds. A
  subclass whose table lacks a column that one of its inherited properties needs
  fails the push when the graph deploys.
- **A shared supertype label carries no OPTIONS and no measures.** A supertype's
  label is bound by every subclass table, and BigQuery forbids a label carried by
  more than one element table from carrying an `OPTIONS` clause or a `MEASURE`. So
  a supertype's own `description`/synonyms are dropped from its label (with a
  warning), and a metric that targets a supertype is skipped (with a warning) —
  attach metrics to a leaf class instead. Subclass and leaf labels are
  unaffected.
- **Each inherited property has one definition under the shared label.** For an
  abstract supertype, the subtype supplies that definition — it binds the
  inherited field to its own column, as `name` is bound above, and that binding is
  used. A concrete supertype already defines the property on its own table, so a
  subtype that declares the same-named field with a different column or expression
  cannot override it: the supertype's definition wins and the subtype's is dropped
  (with a warning). Redeclaring it identically is a harmless no-op.

An entity marked **`abstract: true`** is a conceptual class with no physical
table: it has no `source` and no key, produces **no node table**, and survives
only as a `LABEL` on its concrete descendants. Its field names still flatten
down, and each concrete subtype supplies the column for each of those names, so
the shared label's signature is present on every subtype table. An abstract
entity that no concrete entity extends has nothing to attach to and is dropped
with a warning. `abstract` is an explicit marker: an entity left with an unbound
`source` placeholder is treated as a binding error and fails the push, never
silently dropped as if it were table-less. The Knowledge Catalog leg does not
model inheritance today, so an abstract entity has no physical resource to
catalog and is skipped there (with a warning); its concrete subtypes are
published normally.

A supertype **may** instead be concrete — carry its own `source` and key. It then
becomes both its own node table and a label on its subtypes. Every subtype table
must still expose columns that render to the supertype's property signature, so
each subtype table has to carry the supertype's columns under the same names. The
supertype's own rows and its subtypes' rows are distinct nodes: a real thing
present in both the supertype table and a subtype table is matched twice under the
supertype label. Prefer an abstract supertype unless each real thing lives in
exactly one table under the hierarchy.

**Multiple supertypes and diamonds.** `extends` takes a list, so a subclass may
extend several supertypes and carry every one's label. The push expands `extends`
to the full transitive ancestor set, de-duplicated. A diamond — two supertypes
that share a grandparent — lists that grandparent's label once, so
`MATCH (:Grandparent)` matches the leaf a single time. Depth and breadth do not
change the rules: each concrete table binds every inherited property to its own
column, and these shapes deploy on both BigQuery Graph and Spanner Graph
(verified live for a diamond and for a three-level hierarchy with several
concrete leaves).

## What gets created in Spanner

When the deployment target is a Spanner Graph URI, `push` executes the same
`CREATE OR REPLACE PROPERTY GRAPH` — but generated for Spanner Graph, which
differs from BigQuery Graph in four ways:

| Model element | Spanner construct | Notes |
|---|---|---|
| Model | `PROPERTY GRAPH` | named by the URI's `propertyGraphs/<g>` segment, **bare** (no backticked `project.dataset.` prefix) |
| Entity | `NODE TABLE` | backed by the entity's `source` reduced to its final segment (`proj.ds.Orders` → `Orders`), a table in the target database |
| Relationship | `EDGE TABLE` | connects the two entities' node tables |
| Metric | — dropped | Spanner Graph has no `MEASURE`, so every model-level metric is skipped with a warning; the graph structure still deploys |
| Entity `extends` | extra `LABEL` clauses on the subclass node table | same label-and-flatten handling as BigQuery (see [Class hierarchies](#class-hierarchies-extends--labels)) |

- **Bare table and graph names.** A Spanner property graph lives inside one
  database and names tables in that same database, so the generator emits bare
  names — no `project.dataset.` qualifier on either the tables or the graph.
- **No `MEASURE`.** Metrics are dropped (warned per metric), never errored. The
  BigQuery-only rule that a metric must resolve to a single entity therefore does
  not apply to a Spanner target (see [Validation](#validation)).
- **No per-element `OPTIONS`.** `description` / `synonyms` are not emitted into
  the Spanner DDL; they ride into Knowledge Catalog instead — mirroring how
  BigQuery's graph-level `OPTIONS` is dropped. See
  [What push and pull preserve](fidelity.md#to-spanner).
- **Async DDL.** The statement is applied through the Spanner Admin
  `updateDatabaseDdl` long-running operation, polled to completion (BigQuery runs
  its DDL through `jobs.query`). No region detection is needed — the DDL runs in
  the database the target names.

Under `--validate-only` nothing is applied; add `--print` to see the generated
Spanner DDL. Unlike the BigQuery leg, a Spanner-targeting model's source tables
are **not** probed before deploy — the live pre-flight is BigQuery-only (see
[Validation](#validation)).

## What gets created in Knowledge Catalog

Each element of your model maps to one catalog resource. Every resource type
below is a built-in system type under `dataplex-types/global` — push references
them, it never creates them.

> Set `KC_TYPE_PROJECT` to read these system types from another project, and
> `DATAPLEX_ENDPOINT` to target a non-prod Dataplex host; both default to
> production (`dataplex-types` / `https://dataplex.googleapis.com`).

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
touched**, so a model that cannot deploy fails fast instead of half-deploying.
Each check enforces a rule the [model specification](model_spec.md) *defines*;
this section is the operational side of it — what the tool does when the rule is
broken — and links to the definition it enforces:

* **A graph push declares exactly one deployment target per model, and it must
  be a valid BigQuery Graph or Spanner Graph URI.** A model with more than one is
  rejected, and so is a single target whose URI matches neither
  `//bigquery.googleapis.com/projects/<p>/datasets/<d>/propertyGraphs/<g>` nor
  `//spanner.googleapis.com/projects/<p>/instances/<i>/databases/<db>/propertyGraphs/<g>`
  (for example a `propertyGraph`/`propertyGraphs` typo, or a
  `…/entryGroups/@bigquery/entries/…` entry form). The error names the offending
  URI and the expected forms. A **logical model that declares no target** is
  allowed: it deploys no graph and records to Knowledge Catalog only (so `--no-kc`
  on it is an error — it would have nowhere to go). This gate runs before any
  destination leg, so a malformed target writes **nothing** — not to the graph
  and **not to Knowledge Catalog**; the push aborts with a non-zero exit and no
  entries are created. Defined in [model spec §4.1](model_spec.md#41-narrowings-stricter-than-ossie)
  (one target) and [§7.2](model_spec.md#72-deployment-target) (the URI grammar).
  *(static)*
* **Every metric on a BigQuery Graph model resolves to exactly one entity** —
  otherwise it would be dropped from the BigQuery Graph. Set the metric's attach
  entity, or scope its expression to a single entity. This rule is
  BigQuery-only: Spanner Graph has no `MEASURE`, so a Spanner target drops its
  metrics by design and imposes no such requirement. Defined in
  [model spec §4.1](model_spec.md#41-narrowings-stricter-than-ossie). *(static)*
* **Every entity's source table is reachable.** For a **BigQuery-targeting**
  model, each `source` is probed with a dry-run query, so BigQuery resolves it
  exactly as the deploy will — a three-part `project.dataset.table`, a four-part
  federated REST-catalog name (e.g. an Iceberg table via BigLake), or a quoted
  identifier all work. A table that does not exist or that you cannot access fails
  the push, naming the table and the entity; a `source` that is a query (not a
  table) is skipped. A **Spanner-targeting** model's sources live in Spanner
  (a different system) and are **not** probed here. The `source` construct and its
  URI/dotted forms are defined in [model spec §7.1](model_spec.md#71-table-sources).
  *(live — needs BigQuery access)*

The live table check runs whenever the BigQuery leg runs (some model targets
BigQuery Graph), including under `--no-kc`, because the same tables back both a
BigQuery graph and its Knowledge Catalog entries.

## Permissions

`push` needs access to whichever destinations you deploy to.

**BigQuery** — for a BigQuery-targeting model (the BigQuery leg runs whenever
such a model is present), and for the validation pre-flight:

* `bigquery.jobs.create` in the deployment-target project — to run the deploy's
  `CREATE OR REPLACE PROPERTY GRAPH` and the validation dry-run query
* read access on each entity's source table, so the dry-run can resolve it
* `bigquery.datasets.get` on the target dataset (region detection; optional —
  push degrades gracefully without it)

**Spanner** — for a Spanner-targeting model (the Spanner leg runs whenever such a
model is present), on the database the target names:

* `spanner.databases.updateDdl` — to apply the `CREATE OR REPLACE PROPERTY GRAPH`
  through `updateDatabaseDdl`
* `spanner.databaseOperations.get` — to poll the long-running operation to
  completion

**Knowledge Catalog / Dataplex** — for the Knowledge Catalog push (on by
default; skip it with `--no-kc`):

Writing an entry with aspects needs permission on **both** the entry operation
and each aspect type attached, so a push needs, on the destination entry group:

* `dataplex.entries.create`, `dataplex.entries.update`, `dataplex.entries.delete`,
  and `dataplex.entries.list` — push upserts the model / entity / metric entries
  and deletes orphaned ones
* `dataplex.entryLinks.create` and `dataplex.entryLinks.delete` — the
  `schema-join` links, when the model has relationships
* `dataplex.entryGroups.useSchemaAspect` — every entity carries the built-in
  `schema` aspect (its fields, keys, unique keys, and labels)
* `dataplex.entryGroups.useGuidelinesAspect` — when the model, an entity, or a
  metric carries `ai_context.instructions`
* `dataplex.entryGroups.useSchemaJoinAspect` and
  `dataplex.entryGroups.useSchemaJoinEntryLink` — when the model has relationships
* the `use<AspectType>Aspect` permission for the `semantic-model`,
  `semantic-entity`, and `semantic-metric` aspect types the push attaches — i.e.
  `dataplex.entryGroups.useSemanticModelAspect`, `useSemanticEntityAspect`, and
  `useSemanticMetricAspect`

> The `schema` / `guidelines` / `schema-join` use-permissions follow Dataplex's
> documented `dataplex.entryGroups.use<AspectType>Aspect`
> [pattern](https://cloud.google.com/dataplex/docs/iam-permissions); the
> `semantic-*` names follow the same pattern but are not yet in that public
> reference (the `semantic-*` system aspect types are newer), so confirm them
> against your project's IAM once granted.

`kcmd pull` needs read access to the same entry group instead — to list its
entries and fetch each `semantic-*` entry with its aspects.
