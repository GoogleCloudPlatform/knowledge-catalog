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
| `--no-deployment` | Publish the model to Knowledge Catalog and deploy nothing, after every check of the two-phase path below. It publishes the model file as written, whereas `--no-profile` publishes the binding `default_profile` names. |
| `--validate-only` | Run every validation check and report pass/fail, but write nothing. |
| `--print` | Print each destination's generated artifact (BigQuery or Spanner Graph SQL DDL, Knowledge Catalog entry plan). Combine with `--validate-only` to preview without deploying. |
| `--force-remove` | Delete models in the entry group that this push no longer includes (see [Updating and removing models](README.md#updating-and-removing-models)). |
| `--emit-expressions` | Also write the SQL-expression fields (per-field `schema.semantics` and `semantic-metric.expression`) to Knowledge Catalog. Off by default: the published system-type templates do not carry them yet. Knowledge Catalog push only. |

A push with `--no-deployment` runs in two phases. The first runs every check
for Knowledge Catalog and writes nothing. The second publishes the model to
Knowledge Catalog. On this path `--no-kc`, `--profile`,
`--all-profiles` and `--no-profile` are errors, and catalog.yaml's
`default_profile` chooses no binding: Knowledge Catalog receives the model file
as written.

Any other push prepares the catalog's model, checks that it publishes one
model and checks the file copies before the first graph deploys. Its Knowledge
Catalog leg runs its own checks only after the graphs deploy.

### pull

```bash
kcmd pull
```

Writes back the model file and profile files a push stored in Knowledge
Catalog. It reconstructs the model document from the catalog entries instead
for a model an older `kcmd` pushed, and when no stored file is named after the
model. When it finds that the last push stopped partway, it writes nothing.
Reads only from Knowledge Catalog (never BigQuery); its coordinates come from
the same scope you authored under. See [Pull](README.md#pull) for behavior.

| Flag | Effect |
|------|--------|
| `--dry-run` | Read the catalog and report what would be written, but write or delete no files. |
| `--force-remove` | Replace a differently-named local model with the catalog's (see [Pull](README.md#pull)); without it, a pull that would leave the entry group holding two models fails. Also deletes a local profile file the catalog has no copy of, when the catalog holds copies of the model's files. |

### profiles

```bash
kcmd profiles
```

Reports each binding profile the model declares: its deployment target, the
source each entity binds to, and what the profile cannot answer or cannot run.
Under each profile it then prints every error `kcmd push --profile <name>`
would give for it, after a `push rejects:` heading. The inline `default`
binding is checked too. Beside declared profiles it is listed only when push
would reject it. Some errors fail every push of the scope, such as a second
model in the entry group. When push would stop at such an error,
`kcmd profiles` prints it once above the profiles and still checks each
profile. A Cloud SQL table whose entry cannot be read stops the command before
the report. When `default_profile` names a profile that a model does not declare,
a push that names no profile fails. That error prints above the model's
profiles. When push warns that the model file's own bindings are incomplete,
the report prints that warning under `profile 'default'`, unless `--profile`
names another profile.

The command is read-only. It applies and prunes each profile and generates each
graph as `push --validate-only` does, but deploys nothing, so you can compare
coverage before choosing one. Like push, it reads the Knowledge Catalog entry
of each Cloud SQL table written as its resource name, for the table's dialect.
The other checks that need a service run only at push time: the BigQuery source table probe, the dry runs of action
statements and, on a push without `--validate-only`, the Knowledge Catalog
checks on the entry group. Push's lookup of the file-copy type also runs only
at push time, because it calls a service. It exits non-zero when push would
reject a binding. Until push accepts a deployment that names a profile, the
report refuses one, while `--print-store` takes that profile's store from it.
The report's `target:` line lists the targets of the deployments the profile
uses, the same ones `--print-store` reads. For an AlloyDB target named by its
cluster, `--print-store` calls the AlloyDB API to find the cluster's primary
instance.

| Flag | Effect |
|------|--------|
| `--profile [name]` | Report only this profile. Naming one the model does not declare is an error, not an empty report. Defaults to every profile. |
| `--print-store` | Print only the store the profile deploys to, on one line and nothing else, for a script to read rather than parse out of the report: `project/instance/database` for a Spanner store, and the backend named ahead of the path for any other (`alloydb:project/region/cluster/instance/database`, `bigquery:project/dataset`). The store is the one the deployments for the profile name: those that name it in `profile`, or that name no profile or `default` for `default`. A legacy profile in `<model>.profiles/` that no deployment names takes the deployments for `default`, unless it sets its own `deployment_target`. Of several, it is the single Spanner or AlloyDB store. For an AlloyDB target named by its cluster, the instance printed is the cluster's primary instance. For a legacy instance-based AlloyDB target, it is the instance the target names. Errors when the scope holds more than one model, since those may name different databases, before any AlloyDB call. Also errors when a deployment names a profile the model does not declare, and when no single store results. Like push, it errors when the model's `extends` do not resolve: one names an entity the model does not declare, they form a cycle, or an entity inherits one field from two unrelated ancestors. A target in no accepted form in any deployment fails it under every profile, and so does a target a `GOOGLE` block lists twice. Like push, it reads every model's profiles first: its profile files, and the profiles a vanilla model carries in its `GOOGLE` block. It errors on a profile file that breaks one of the layout's file rules, such as a `<model>.profile.<name>.yaml` file whose `name:` does not match its file name, on a `GOOGLE` block profile that does not load, and on a profile named `default` in any letter case. Like push, it also errors on a profile file that does not load, such as a file in `<model>.profiles/` whose `name:` does not match its file name. It does not run push's checks that every named profile applies to the model, that each is complete, and that each has valid keys and join columns. So a profile that leaves an entity without a source does not stop it. It does not run push's deployment checks, its dialect check of the model file's fields, or its check that each concrete entity restates the inherited fields that read a column either. It does not run push's checks on the copies of the model and profile files that push stores in Knowledge Catalog, such as whether each file is valid UTF-8. For an AlloyDB cluster it also errors when the cluster has no primary instance, when the primary is not READY, or when the instance listing fails. |

This is a read of the binding, never a choice of one. Nothing on any `kcmd`
command line names a store directly; `--profile` selects a binding and the
binding's deployment target decides where writes land. A script that creates,
seeds or drops that database asks for the name rather than repeating it:

```bash
IFS=/ read -r PROJECT INSTANCE DATABASE <<<"$(kcmd profiles --print-store)"
```

### skills-generate

```bash
kcmd skills-generate
```

Writes each model in the scope out as an [Agent Skill](https://agentskills.io/)
folder: a `SKILL.md` naming the model, routing to its actions and saying what a
call comes back as, and one `references/<action>.md` per action carrying that
action's arguments, rules and blast radius. It reads the model, touches no
store, calls no judge, and runs nothing. For an AlloyDB target named by its
cluster, it calls the AlloyDB API to find the cluster's primary instance.

A skill names the store only for a model with actions, in its "Running an
action" section. The command fails without writing anything when push rejects
the deployments. That happens when the target of any deployment is in no
accepted form, whichever profile the deployment is for. It also happens when
several targets leave the store ambiguous, or when a deployment names a profile
the model does not declare. Until push accepts a deployment that names a
profile, the command accepts one that names `default` or a declared profile,
which push refuses. It also accepts a profile file that no deployment uses,
which every graph push refuses, and writes a skill whose store line says there
is none. A vanilla model lists its deployments or targets in a `GOOGLE` block.
The command fails the same way when a target there is in no accepted form or
listed twice, or when the block's data is not valid JSON. Like push, it reads
every model's profiles first: its profile files, and the profiles a vanilla
model carries in its `GOOGLE` block. It fails on a profile file that breaks one
of the layout's file rules, such as a `<model>.profile.<name>.yaml` file whose
`name:` does not match its file name, on a `GOOGLE` block profile that does not
load, and on a profile named `default` in any letter case. Like push, it also
fails on a profile file that does not load, such as a file in
`<model>.profiles/` whose `name:` does not match its file name. It does not run
push's checks that every named profile applies to the model and that each is
complete. So it still writes a skill when a profile leaves an entity without a
source. It does not run push's checks on the copies of the model and
profile files that push stores in Knowledge Catalog, such as whether each file
is valid UTF-8. It does not check that the entry group holds one model, or that
two models deploy to different graphs. Of push's checks on
the model itself, it runs only the one on inheritance. It fails when an
`extends` names an entity the model does not declare, when `extends` forms a
cycle, or when an entity inherits one field from two unrelated ancestors. It
runs none of the others, such as a concrete entity with no source or an action
guarded by a constraint the model lacks.

For a model with actions, it also fails without writing anything when the
profile names a store that cannot be resolved. That happens when the model
binds a table outside its Spanner or AlloyDB store, when the AlloyDB cluster
has no primary instance, when the primary is not READY, or when the instance
listing fails. A model with no actions still gets its skill in those cases,
since the skill does not name the store.

A BigQuery graph may read tables in other datasets, as push allows. For such a
model, and for a profile whose deployments name no target, the store line says
there is none and gives the reason.

A skill's `name` and the directory it sits in have to match, or a client skips
it. So the directory is named from what was generated rather than from anything
the caller typed, and a name the format does not allow fails before anything is
written.

Everything the binding decides lives in `SKILL.md`: the store, the executor
kinds, and which actions this deployment cannot run and why, all under one
heading, plus the snippet for reading the store directly. A reference page is
the same bytes under any profile.

A guarded action is always described as runnable, because a rule stated in words
is settled by the runtime before the transaction opens and a guarded action only
ever runs against a runtime that has a judge. There is no flag here to say
otherwise: whether the caller of `skills-generate` had a judge configured is a
fact about that invocation, not about the deployment the document is read
against.

| Flag | Effect |
|------|--------|
| `--out <dir>` | Directory the skill directories are written under. Defaults to `skills`. |
| `--name <name>` | Name the skill, and so its directory. Defaults to the model's own name. Rejected when the scope holds more than one model, because a name names one skill. |
| `--profile [name]` | Read the model under this binding profile. Defaults to `default_profile`, else the model's inline bindings. It is what the one deployment-specific section describes. |
| `--force` | Replace a skill already at that path. A reference page for an action the model no longer declares is deleted and reported; a file outside `references/` is left alone. |

Before anything is written, a warning is printed when no action in a model is
runnable under the selected profile, because a skill that can run nothing is
rarely what was meant. Two models in one scope whose names normalize to one
skill name are refused rather than one overwriting the other. See
[Generating an Agent Skill](skills.md).

## What gets created in BigQuery

`push` executes a single `CREATE OR REPLACE PROPERTY GRAPH` per deployment
target, in the project and dataset the target names. Each part of your model
becomes one part of that graph:

| Model element | BigQuery construct | Notes |
|---|---|---|
| Model | `PROPERTY GRAPH` | named by the deployment-target URI |
| Entity | `NODE TABLE` | backed by the entity's `source` table, keyed by its primary key |
| Relationship | `EDGE TABLE` | connects the two entities' node tables |
| Metric | `MEASURE` on a node table | must resolve to a single entity and reduce to one supported aggregate over one operand (otherwise the push is rejected; see [Validation](#validation)) |
| Entity `extends` | extra `LABEL` clauses on the subclass node table | the subclass also matches its supertypes; the supertypes' fields flatten down (see [Class hierarchies](#class-hierarchies-extends--labels)) |
| Action | *nothing* | an action reaches Knowledge Catalog only (see below); the BigQuery push deploys none and warns once |
| Constraint | *nothing* | a constraint reaches Knowledge Catalog only (see below); the BigQuery push deploys none and warns once |

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
    fields:
      - { name: id,   datatype: Integer }
      - { name: name, datatype: String }
  - name: Customer
    extends: [Party]           # the one keyword you add
    primary_key: [id]          # each subclass keeps its OWN key; keys do not inherit
    source: bigquery.googleapis.com/projects/proj/datasets/ds/tables/customer
    fields:
      - { name: id,   expression: c_custkey }
      - { name: name, expression: c_name }                      # the inherited field, bound to this table's column
      - { name: tier, datatype: String, expression: c_tier }
  - name: Supplier
    extends: [Party]
    primary_key: [id]
    source: bigquery.googleapis.com/projects/proj/datasets/ds/tables/supplier
    fields:
      - { name: id,     expression: s_suppkey }
      - { name: name,   expression: s_name }
      - { name: rating, datatype: Integer, expression: s_rating }
```

**The supertype's fields flatten down** onto each subclass. A supertype
contributes its field names to every subclass, ordered own fields first then
inherited. An abstract supertype binds no columns of its own, so each subtype
supplies the column for every inherited name on its own table — `id` and `name`
above are bound on both the customer and the supplier. Under a concrete
supertype, a subtype restates each inherited field whose supertype expression
reads a column. This holds in each named profile, and in the model file when it
gives the subtype a source. A field whose supertype expression reads only other
fields flattens straight down.

A subtype redeclares an inherited field only to bind it. The redeclaration
names the field and gives it a column of the subtype's table. The datatype,
label, dimension, description, `ai_context` and `custom_extensions` come from
the ancestor that declares the field, and push rejects a redeclaration that
restates any of them, or gives nothing but the name. A subtype that does not bind an inherited field takes the
binding of the nearest ancestor that does. Under a concrete supertype the graph
keeps the supertype's binding either way, as the boundaries below describe.

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
  node table is identified by its own grain, never its supertype's). An edge
  declared on a supertype would join only the supertype's own rows and miss
  every subtype, so push rejects a relationship that connects an abstract
  entity or one that another entity extends. Declare such an edge on each
  concrete leaf, for example `Customer —livesIn→ City`.
- **The subclass's `source` must physically expose every inherited column.** The
  flattened `name` above is read from `proj.ds.customer`, so that table (or a view
  over it) must include the column that `Customer`'s `name` field binds. A
  subclass whose table lacks a column that one of its inherited properties needs
  fails the push when the graph deploys.
- **A shared supertype label carries no OPTIONS and no measures.** A supertype's
  label is bound by every subclass table, and BigQuery forbids a label carried by
  more than one element table from carrying an `OPTIONS` clause or a `MEASURE`. So
  a supertype's own `description`/synonyms are dropped from its label (with a
  warning). For the same reason push rejects a metric that belongs to an
  abstract entity or to one that another entity extends. Attach metrics to a
  leaf class instead. Subclass and leaf labels are unaffected.
- **Each inherited property has one definition under the shared label.** For an
  abstract supertype, the subtype supplies that definition — it binds the
  inherited field to its own column, as `name` is bound above, and that binding is
  used. A concrete supertype already defines the property on its own table, so a
  subtype that declares the same-named field with a different column or expression
  cannot override it: the supertype's definition wins and the subtype's is dropped
  (with a warning). Redeclaring it with the same column is a harmless no-op.

An entity marked **`abstract: true`** is a conceptual class with no physical
table: it has no `source`, no key and no field expressions, produces **no node
table**, and survives only as a `LABEL` on its concrete descendants. Push
rejects an abstract entity that declares a `source`, a `primary_key`, a
`unique_keys` entry or a field expression. Its field names still flatten
down, and each concrete subtype supplies the column for each of those names, so
the shared label's signature is present on every subtype table. An abstract
entity that no concrete entity extends has nothing to attach to and is dropped
with a warning. `abstract` is an explicit marker: a non-abstract entity with no
`source` is treated as a binding error and fails the push, never
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
supertype label. Because other entities extend it, a concrete supertype cannot
be a relationship endpoint or own a metric. Prefer an abstract supertype unless
each real thing lives in exactly one table under the hierarchy.

**Multiple supertypes and diamonds.** `extends` takes a list, so a subclass may
extend several supertypes and carry every one's label. The push expands `extends`
to the full transitive ancestor set, de-duplicated. A diamond — two supertypes
that share a grandparent — lists that grandparent's label once, so
`MATCH (:Grandparent)` matches the leaf a single time. A field may be declared
or rebound on only one side of a diamond. When two supertypes that do not extend
each other both declare or rebind the same field, push rejects the model,
because nothing says which definition wins. A field that reaches the leaf by two
paths from a single declaration on the shared grandparent is fine. `extends` may
not form a cycle, and push rejects one. Depth and breadth do not
change the rules: each concrete table binds every inherited property to its own
column, and these shapes deploy on both BigQuery Graph and Spanner Graph
(verified live for a diamond and for a three-level hierarchy with several
concrete leaves).

## What gets created in Spanner

When the deployment target is a Spanner graph, `push` executes the same
`CREATE OR REPLACE PROPERTY GRAPH` — but generated for Spanner Graph, which
differs from BigQuery Graph in five ways:

| Model element | Spanner construct | Notes |
|---|---|---|
| Model | `PROPERTY GRAPH` | named by the target's `graphs/<g>` segment, **bare** (no backticked `project.dataset.` prefix) |
| Entity | `NODE TABLE` | backed by the entity's `source` reduced to its final segment (`spanner.googleapis.com/…/tables/Orders` → `Orders`), a table in the target database |
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
- **Its own SQL.** A field reads its `SPANNER` expression, else its `ANSI_SQL`
  one, and is left out with a warning when it has neither.
- **Async DDL.** The statement is applied through the Spanner Admin
  `updateDatabaseDdl` long-running operation, polled to completion (BigQuery runs
  its DDL through `jobs.query`). No region detection is needed — the DDL runs in
  the database the target names.

Under `--validate-only` nothing is applied; add `--print` to see the generated
Spanner DDL. Unlike the BigQuery leg, a Spanner-targeting model's source tables
are **not** probed before deploy. Its actions are: every `sql` executor
statement is planned against the target database first, on both legs (see
[Validation](#validation)).

## What gets created in Knowledge Catalog

Each element of your model maps to one catalog resource. Every resource type
below except `semantic-action`, `semantic-constraint` and `semantic-model-file`
is a built-in system type under `dataplex-types/global` — push references them,
it never creates them. Those three are custom, and `kcmd init --semantic-model`
creates them in your own project at `global`; push still writes only entries.

> Set `KC_TYPE_PROJECT` to read these system types from another project, and
> `DATAPLEX_ENDPOINT` to target a non-prod Dataplex host; both default to
> production (`dataplex-types` / `https://dataplex.googleapis.com`).

| Model element | Catalog resource | Kind | Id |
|---|---|---|---|
| Model | `semantic-model` | entry — anchor / parent of the rest | `<model>` |
| Entity | `semantic-entity` (+ built-in `schema` aspect) | entry | `<model>.entities.<entity>` |
| Metric | `semantic-metric` | entry | `<model>.metrics.<metric>` |
| Relationship | `schema-join` | entry link between the two entity entries | derived from the model and relationship names |
| Action | `semantic-action` (custom type) | entry | `<model>.actions.<action>` |
| Constraint | `semantic-constraint` (custom type) | entry | `<model>.constraints.<constraint>` |
| Model file and each profile file | `semantic-model-file` (custom type) | entry holding the file's text | `<model>.files.<file>` |

The model entry also carries the `kcmd-push-id` label, which names the push that
stored the file copies. On each entry, push owns the `schema`, `semantic-*` and
`guidelines` aspects it writes, the display name, the description and that
label. When it updates an entry, it keeps every other label and the source
`resource`, `system`, `platform`, `createTime` and `updateTime` another tool
set.

An entity entry carries its columns in the `schema` aspect (name, data type,
description, and any `label` per field), plus the entity's keys and unique keys
(`primaryKey` / `uniqueConstraints`); a `schema-join` link carries the
relationship detail — the paired columns and foreign-key direction — in its
aspect. Any element with `ai_context.instructions` (the model, an entity, or a
metric) also gets a built-in `guidelines` aspect holding that text.

An **action** entry carries its executor, its typed parameters, the names of the
constraints that gate it (`guards`), and the concepts it changes (`affects`) in
a `semantic-action` aspect, along with the action's `ai_context.instructions`. A
guard is stored as the constraint name, matching a sibling `semantic-constraint`
entry on the same model, so a reader holding one action entry can find the rules
it is checked against. An affected concept is stored as its name — an entity or
a relationship, named the same way, since the model is what says which.
That aspect type is provisioned in your project rather than referenced from
`dataplex-types`, because Dataplex has no built-in action type yet; when one
ships, the entries move to it and their shape does not change. (This is the
prototype scope — an action's `precondition` is not modeled yet, and nothing
consumes its `affects`.)

A **constraint** entry carries its rule in a `semantic-constraint`
aspect, together with the whole of any `ai_context` declared on it. The rule
sits in the one body a constraint has, `judgment`: the condition written as a
sentence, settled by a language model reading the attempted call. The aspect
type also declares `expression` and `evaluation`, which nothing writes and
nothing reads. They are kept so that an aspect type already provisioned in your
project still matches what `kcmd init` would create, and an entry left holding
an old `expression` reads back as a named skip rather than as a rule. The
constraint's `description` is the entry's own summary, because that sentence is
what a caller refused by the rule reads. Its type is provisioned alongside the action pair and
for the same reason. All three parts of `ai_context` survive, unlike an element
routed to the built-in `guidelines` aspect, which has a home for `instructions`
alone: `kcmd` defines the constraint aspect itself, so it has no reason to keep
that limit.

The aspect also carries the constraint's two routing words: `onViolation` (what
the engine does to the write — `reject`, `escalate` or `warn`) and `severity`
(how grave the breach is — `critical`, `high`, `medium` or `low`). They ride the
aspect rather than the entry source because they are machine-readable and not
prose. `onViolation` is required of every constraint, and `severity` is not: one
that declares no severity is published without the field and reads back without
it, so the ranking stays the model's to define. Each is read on its own, so an
unrecognized word in one is dropped on pull with a warning without costing the
reader the other. An unreadable `severity` leaves the rule unranked, which
nothing reads yet. An unreadable `onViolation` is dropped too, but there is no
fallback to drop to now that the word is required: the pull warns that the
constraint will not push, and loading the pulled model names the constraint and
says the word is missing. That is the outcome to want when the catalog no
longer says how a breach routes.

The catalog's metadata does not hold your whole model, so push also stores a
copy of each model file and profile file, which pull returns. For exactly what
the metadata stores, what is gated behind `--emit-expressions`, and what is
never stored, see
[What push and pull preserve](fidelity.md#to-knowledge-catalog).

### With `KC_V2_ASPECTS=1`

With `KC_V2_ASPECTS=1`, push writes a newer set of Knowledge Catalog
types. Each relationship other than a many-to-many association has an entry of
its own. Entry ids are `<model>`, `<model>/entities/<entity>`,
`<model>/metrics/<metric>` and `<model>/relationships/<relationship>`.

A `semantic-link` joins each ordered pair of related entities. Built-in
`reference` links run from each relationship's entry to the entries of its
source and target entities. An unbound relationship gets its `reference` links
too. Their ids start with `semantic-relationship-`, followed by the first 32
hex characters of a SHA-256 hash of `<model>/<relationship>/source` or
`<model>/<relationship>/target`. Push owns only the `reference` links with that
prefix. It deletes the ones the model no longer has and leaves every other
`reference` link alone.

`semantic-metric.entity` holds the metric's entity, declared or derived.
`excludedInProfiles` follows the order of the model entry's `profiles` list.

Push writes the whole `overview` aspect of the model's entry and of each metric
and relationship entry from the workspace, and never reads it back. `examples`
come from the model file's `ai_context.examples`. `content`, `contentType` and
`links` come from the entry's sidecar, the file `<entry-id>.overview.md` in the
directory that holds `<model>.yaml`. For example, the model's sidecar is
`<model>.overview.md` and a metric's is `<model>/metrics/<metric>.overview.md`.
The sidecar's frontmatter holds `contentType` and `links`, and its body is
`content`. `contentType` is `MARKDOWN` or `HTML`. Each link has a `url` and an
optional `title`. A malformed sidecar fails the push before anything is
written. Push warns about a sidecar that names no entry of the model. An
overview edited in the console does not survive a push.

## Validation

`push` and `--validate-only` run the same checks, apart from the Knowledge
Catalog checks on the entry group, which only a push without `--validate-only`
runs. [push](#push) says when each check runs.
Each check enforces a rule the [model specification](model_spec.md) *defines*;
this section is the operational side of it — what the tool does when the rule is
broken — and links to the definition it enforces:

Before these checks even run, the document must **load**, and the loader is strict:
`version` is required and must be `0.2.0.dev0` (vanilla Ossie) or
`0.2.0.dev0/google` (the extended profile); every object is closed, so an unknown
key — including a native key under vanilla, or a `custom_extensions` block under
`/google` — is rejected; names must be unique within their scope; every
`extends` must name an entity defined in the model; a field's or metric's
`expression`, in the string form and in each dialect entry, may not be empty,
only whitespace or only a comment; and a field's `expression` may not be only
its entity's qualifier, such as `orders.`. A load failure is reported the
same way as a validation failure — nothing is touched, non-zero exit — and is
defined in [model spec §1](model_spec.md#1-status-and-baseline),
[§2](model_spec.md#2-document-shape), [§6](model_spec.md#6-the-extension-mechanism),
and [§4.1](model_spec.md#41-narrowings-stricter-than-ossie).

* **A graph push declares exactly one deployment target per model, and it must
  be a valid BigQuery Graph or Spanner Graph resource name.** A model with more
  than one is rejected, and so is a single target that matches neither
  `bigquery.googleapis.com/projects/<p>/datasets/<d>/propertyGraphs/<g>` nor
  `spanner.googleapis.com/projects/<p>/instances/<i>/databases/<db>/graphs/<g>`
  (for example a `propertyGraph` typo, a Spanner graph under `propertyGraphs/`,
  a leading `//`, or a `…/entryGroups/@bigquery/entries/…` entry form). The
  error names the offending target and what to write instead. A **logical model
  that declares no target** is allowed: it deploys no graph and records to
  Knowledge Catalog only (so `--no-kc` on it is an error — it would have
  nowhere to go). This gate runs before any destination leg, so a malformed
  target writes **nothing** — not to the graph and **not to Knowledge
  Catalog**; the push aborts with a non-zero exit and no entries are created.
  Defined in [model spec §4.1](model_spec.md#41-narrowings-stricter-than-ossie)
  (one target) and [§7.2](model_spec.md#72-deployment-target) (the grammar).
  *(static)*
* **Every metric on a BigQuery Graph model resolves to exactly one entity** —
  otherwise it would be dropped from the BigQuery Graph. Set the metric's attach
  entity, or scope its expression to a single entity. This rule is
  BigQuery-only: Spanner Graph has no `MEASURE`, so a Spanner target drops its
  metrics by design and imposes no such requirement. Defined in
  [model spec §4.1](model_spec.md#41-narrowings-stricter-than-ossie). *(static)*
* **Each deployment meets the rules of its engine.** Every push checks each
  deployment the model declares, whichever binding the push deploys. A
  deployment that names no profile uses the model file's own bindings. They
  must give every concrete entity a source and every relationship both join
  column lists. They must also bind every field that each deployed metric
  reads, directly or through another field. An AlloyDB deployment reads only
  the `ALLOYDB` or `ANSI_SQL` text of each metric and field. A Spanner
  deployment deploys no metric. A BigQuery deployment turns each metric into a
  measure, so each metric must be `SUM`, `AVG`, `COUNT`, `MIN` or `MAX` over
  one operand, and the entity it belongs to needs a primary key or a unique
  key. The measure rule skips a metric that has only a vendor text.
  A push of a profile in the older `<model>.profiles/` layout deploys that
  profile's bindings instead, so it skips this check. *(static)*
* **Each field the model file binds has a text its entity's database runs.**
  The field needs an entry in the dialect of its entity's source, an
  `ANSI_SQL` entry, or the string form. The model file's own bindings may span
  systems, so each entity is judged by its own source. With `--transpile`, a
  text that push translates into BigQuery SQL also counts. Every push runs this
  check, whether or not a deployment uses those bindings. *(static)*
* Every class hierarchy follows the inheritance rules. `extends` forms no cycle,
  and no field is declared by two supertypes that do not extend each other. A
  subtype redeclares an inherited field only to bind it. A concrete entity
  with a source restates each inherited field whose ancestor's expression reads
  a column. An
  abstract entity declares no source, key or field expression. Relationships
  and metrics attach only to concrete leaf entities. The rules and their
  reasons are in [Class hierarchies](#class-hierarchies-extends--labels).
  These checks run on every push, including a `--no-profile` push to
  Knowledge Catalog alone. *(static)*
* **Relationships join two different entities in one direction.** Push rejects
  a relationship from an entity to itself, and relationships in both directions
  between two entities. *(static)*
* **Every action is well-formed.** Each action parameter must settle on one
  scalar datatype: projected from a field it names with `concept` and `field`,
  or stated as its own `type`. Naming an entity as a `type`, or restating a
  projected parameter's type, is rejected. Two parameters a caller could confuse
  — projecting the same field, or sharing a declared type — must each carry
  their own `description`. Each executor must carry its coordinates (an `mcp`
  server + tool, a `rest` endpoint + method, a `grpc` service + method, or at
  least one non-blank `sql` statement) with no blank field. A coordinate omitted altogether is rejected earlier, when the
  model is parsed. An action with *no* executor is not an error at all: the
  executor is a physical binding, so an action no binding performs here is still
  a declaration worth publishing. Each name in the
  action's `guards` must resolve to a constraint that the same model declares. A
  guard resolving to nothing leaves the author believing the write is checked
  when nothing checks it. Every `concept` in the action's `affects` must
  likewise resolve to an entity or a relationship the same model declares, and
  its `fields` must be fields of that concept — for a relationship, the
  properties of the junction table backing a many-to-many edge, so a plain
  foreign-key edge has none. Naming fields beside a `delete` is rejected,
  because a `delete` takes the whole instance. An affected concept that resolves
  to nothing is reported and then left alone, since every later check about it
  is meaningless; undeclared fields do not chain that way, so a concept that
  does resolve reports every field it does not have. Everything that reads the
  ontology — the concept check and the field check both — stands down on a
  profile push, because pruning drops whole entities and whole relationships as
  well as unbound fields, and an action reaches no graph in any case. Pruning
  now drops an action that names a dropped *concept*, so for the concept check
  the offending action is gone before the check would run; it does not drop one
  whose `affects` names a pruned *field*, so a blast radius can still name a
  field the published entity no longer carries, and nothing reports it. The
  fields-beside-a-`delete` check reads only the entry, so it still applies. A `sql` executor is checked further, because it carries the
  write itself rather than a pointer to whoever performs it: each statement must
  begin with `INSERT`, `UPDATE` or `DELETE`, must contain no `;` other than a
  trailing one, and may reference only `@parameter` names the action declares.
  Together those are what let every value be bound instead of interpolated, so
  an argument cannot reach the store as SQL. Where the key of an inserted row
  comes from is the statement's own business: a SQL function such as
  `GENERATE_UUID()`, a declared parameter, or a key column left out where it
  has a default. `affects` has no bearing on it. A declared parameter hands the
  key to the caller, and since the verb check reads only a statement's first
  word, an upsert passes and overwrites the row that key names. Four further
  rules are enforced at parse time: exactly one executor kind (`executor
  requires exactly one kind, but 2 given (mcp, rest)`),
  the closed `create` / `modify` / `delete` vocabulary for `operation`, the
  rejection of a repeated guard name, and the rejection of a repeated
  concept-and-operation pair in `affects`. Every check named so far is static —
  it reads the document alone — so it runs on every push, regardless of
  destination. What the *names* in a statement mean is settled live instead, by
  the store the profile binds: see the DML pre-flight under
  [Validation](#validation). Note that actions themselves
  deploy **only** through the Knowledge Catalog leg — a
  graph-only `--no-kc` push validates them but has nowhere to put them, and
  warns that they will not be deployed. *(static, plus a live pre-flight for a
  `sql` executor)*
* **Every constraint states its rule as a judgment.** A constraint has one
  body, `judgment`, and it must be non-empty; one declaring no judgment states
  no rule at all, and the error names it. `expression` is a reserved key: a
  model stating one is answered with a sentence telling the author to restate
  the rule in words, rather than with an unrecognized-key error that explains
  nothing. What a judgment costs is in
  [Actions](actions.md#what-a-judgment-costs). *(static)*
* **Every constraint says what a violation does.** `on_violation` is required
  rather than defaulting. Any of the three words is allowed, `reject` included;
  leaving the key out is the error, because an unmarked constraint rejects and
  that is too strong a consequence to inherit by silence. Every `Entity.field`
  token in the judgment is resolved against the model, so a field name that has
  been renamed out from under the sentence is caught. Quoted text is scanned
  too: in prose, quotes usually set off a field name for emphasis, and skipping
  those would hide the renames this check exists to catch. A qualifier that is
  not a known entity — a relationship-qualified name like `OrderedAs.quantity`,
  or a metric reference — is left alone rather than guessed at, so a valid
  sentence is never falsely rejected. So is a token whose **tail** names
  something the model declares that is not a field of the head: `Customer.Order`
  and `LineItem.BelongsTo` are traversals, and `Order.total_revenue` names a
  metric, none of which the check can settle. So is an entity that declares no
  fields, since fields are optional and a logical model may declare none; an
  empty list is no evidence that a field is missing. So is a token carrying a
  third dotted segment, which is a path rather than a field. What is left is the
  case the check exists for: a tail the model declares under no kind at all,
  next to an entity it does declare. *(static)*
* Like an action, a constraint reaches Knowledge Catalog only, and a `--no-kc`
  push warns that it will not be deployed. Two rules are enforced at parse time:
  `on_violation` and `severity` are each a closed vocabulary — `reject` /
  `escalate` / `warn` and `critical` / `high` / `medium` / `low` — so an
  unrecognized word is a hard load error rather than a value that publishes and
  means nothing. *(static)*
* **Every entity's source table is reachable.** For a **BigQuery-targeting**
  model, each `source` is probed with a dry-run query, so BigQuery resolves it
  exactly as the deploy will — a BigQuery table or a BigLake table (e.g. an
  Iceberg table in a federated REST catalog). A table that does not exist or that
  you cannot access fails the push, naming the table and the entity. A
  **Spanner-targeting** model's sources live in Spanner (a different system) and
  are **not** probed here. The `source` construct and the resource names it takes
  are defined in [model spec §7.1](model_spec.md#71-table-sources).
  *(live — needs BigQuery access)*
* **Every `sql` executor statement is accepted by the store it will run
  against.** Each statement is sent to the bound store with the request that
  means *plan it, do not run it* — `dryRun` on BigQuery, `queryMode: PLAN` in an
  uncommitted read-write transaction on Spanner — so the store parses, resolves
  and type-checks it without writing anything. That catches a table or a column
  the database does not have (answered with the store's own *Did you mean
  `account_id`?*), a placeholder or a function from the wrong dialect, and a
  parameter whose declared type does not match the column it is compared with:
  the parameter types the action declares are sent with the statement, unbound,
  which is what turns them into a claim the store checks. The database a
  statement is planned against is the one the profile deploys the graph to, so
  which store answers is the profile's choice, not the statement's. Failing to
  reach the store at all fails the push rather than skipping the check — a push
  that could not verify its statements must not proceed as though it had.
  *(live — needs query access to the bound store)*

The live table check runs whenever the BigQuery leg runs (some model targets
BigQuery Graph), including under `--no-kc`, because the same tables back both a
BigQuery graph and its Knowledge Catalog entries. The DML pre-flight rides the
same two legs: it runs before the BigQuery deploy and before the Spanner deploy,
and both run under `--validate-only`, so a statement fails while nothing has
been published. Two kinds of model run neither leg and are therefore checked
statically and no further: a catalog-only model, which declares no deployment
target at all, and an **AlloyDB**-targeting one — AlloyDB is a valid deployment
target and a valid store for an action to write to, but push has no client for
it, so its statements are never sent anywhere. Neither case is reported as
verified.

## Permissions

`push` needs access to whichever destinations you deploy to.

**BigQuery** — for a BigQuery-targeting model (the BigQuery leg runs whenever
such a model is present), and for the validation pre-flight:

* `bigquery.jobs.create` in the deployment-target project — to run the deploy's
  `CREATE OR REPLACE PROPERTY GRAPH` and both pre-flight dry runs
* read access on each entity's source table, so the dry-run can resolve it
* read access on each table an action's `sql` executor names, for the same
  reason — a dry run of a DML statement resolves the table it writes to, though
  it writes nothing
* `bigquery.datasets.get` on the target dataset (region detection; optional —
  push degrades gracefully without it)

**Spanner** — for a Spanner-targeting model (the Spanner leg runs whenever such a
model is present), on the database the target names:

* `spanner.databases.updateDdl` — to apply the `CREATE OR REPLACE PROPERTY GRAPH`
  through `updateDatabaseDdl`
* `spanner.databaseOperations.get` — to poll the long-running operation to
  completion
* `spanner.sessions.create` and `spanner.sessions.delete`,
  `spanner.databases.select`, and
  `spanner.databases.beginOrRollbackReadWriteTransaction` — the DML pre-flight
  plans each statement on a session, and a `PLAN` of a DML statement has to open
  the read-write transaction it would write in even though it never commits one.
  All four come with `roles/spanner.databaseUser`.

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
* `dataplex.entryGroups.useReferenceEntryLink` — with `KC_V2_ASPECTS=1`, when
  the model has relationships
* the `use<AspectType>Aspect` permission for the `semantic-model`,
  `semantic-entity`, and `semantic-metric` aspect types the push attaches — i.e.
  `dataplex.entryGroups.useSemanticModelAspect`, `useSemanticEntityAspect`, and
  `useSemanticMetricAspect`
* `dataplex.aspectTypes.use` on the `semantic-action` aspect type, when the
  model declares actions, and on `semantic-constraint` when it declares
  constraints — those types are custom rather than built-in, so they are
  authorized on the type resource instead of through an entry-group
  use-permission

> The `schema` / `guidelines` / `schema-join` use-permissions follow Dataplex's
> documented `dataplex.entryGroups.use<AspectType>Aspect`
> [pattern](https://cloud.google.com/dataplex/docs/iam-permissions); the
> `semantic-*` names follow the same pattern but are not yet in that public
> reference (the `semantic-*` system aspect types are newer), so confirm them
> against your project's IAM once granted.

`kcmd init --semantic-model` creates what a later push only references, so it
needs more than push does, in the destination project:

* `dataplex.entryGroups.create` — the destination entry group
* `dataplex.aspectTypes.create` / `dataplex.aspectTypes.update` and
  `dataplex.entryTypes.create` — the custom `semantic-action`,
  `semantic-constraint` and `semantic-model-file` pairs. Init patches an aspect
  type that is already there, so a project set up by an older `kcmd` picks up
  template additions; an entry type that is already there is left alone.

The entry group and the `semantic-model-file` pair are required. Every push
stores the model file and its profile files with that type, so init fails when
the type is missing and it cannot create it, and a push into a project that
lacks it stops before writing anything and asks you to run
`kcmd init --semantic-model`. A project set up by an older `kcmd` needs that
once. When the entry group or a type already exists, init goes on even if you
may not create or update it, and reports a refusal to update a type as a
warning, so a teammate without these permissions can still run init in a
project someone else set up. Actions and constraints are optional
constructs, so init reports a refusal to create their types as a warning and
carries on; every model that declares neither still pushes and pulls. Any other
failure to create a type stops init, rather than leaving a later push to hit an
opaque parsing error.

`kcmd pull` needs read access to the same entry group instead — to list its
entries and fetch each `semantic-*` entry with its aspects.
