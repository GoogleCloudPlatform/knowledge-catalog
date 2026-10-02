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

### profiles

```bash
kcmd profiles
```

Reports each binding profile the model declares: its deployment target, the
source each entity binds to, and what the profile cannot answer or cannot run.
Read-only — it merges and prunes each profile the way `push` does, but deploys
nothing and runs no live probe, so you can compare coverage before choosing one.

| Flag | Effect |
|------|--------|
| `--profile [name]` | Report only this profile. Naming one the model does not declare is an error, not an empty report. Defaults to every profile. |
| `--print-store` | Print only the store the profile deploys to, on one line and nothing else, for a script to read rather than parse out of the report: `project/instance/database` for a Spanner store, and the backend named ahead of the path for any other (`alloydb:project/region/cluster/instance/database`, `bigquery:project/dataset`). Errors when the scope holds more than one model, since those may name different databases. |

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
action's arguments, rules and blast radius. Reading the model is all this does --
it touches no store, calls no judge, and runs nothing.

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

### owl import

```bash
kcmd owl import <file.ttl> [<file.ttl> ...]
```

Converts a Turtle OWL ontology into one semantic-model document (see
[Importing an OWL ontology](owl-import.md)). Several files are the modules of
**one** ontology: they are merged (an RDF merge — cross-file `rdfs:subClassOf`,
`rdfs:domain` and `rdfs:range` references resolve) into a single model. An
`owl:imports` in any of them is followed to a **local** file only: one already
given on the command line, or one beside the importing file named after the
imported IRI's last segment (`…/ontology/core` → `core.ttl`) whose own
`owl:Ontology` IRI matches. An import that resolves to no such file is warned
and skipped — nothing is fetched over the network. The first file's ontology
header describes the model.

| Flag | Effect |
|------|--------|
| `--name <model>` | Name the model. Defaults to the first file's stem (`sales.owl.ttl` → `sales`). |
| `--out <path>` | Write the document to this path instead of the semantic-model layout dir. |
| `--compact` | Emit the compact flow YAML layout instead of the default block layout. |

## What gets created in BigQuery

`push` executes a single `CREATE OR REPLACE PROPERTY GRAPH` per deployment
target, in the project and dataset the target names. Each part of your model
becomes one part of that graph:

| Model element | BigQuery construct | Notes |
|---|---|---|
| Model | `PROPERTY GRAPH` | named by the deployment-target URI |
| Entity | `NODE TABLE` | backed by the entity's `source` table, keyed by its primary key |
| Relationship | `EDGE TABLE` | connects the two entities' node tables |
| Relationship `inverse` | a second `EDGE TABLE` over the same backing table | `SOURCE`/`DESTINATION` swapped, labeled with the inverse name (see [Relationship inverses](#relationship-inverses-inverse)) |
| Metric | `MEASURE` on a node table | must resolve to a single entity (otherwise the push is rejected — see [Validation](#validation)) and reduce to one supported aggregate over one operand (otherwise that metric is skipped with a warning) |
| Entity `extends` | extra `LABEL` clauses on the subclass node table | the subclass also matches its supertypes; the supertypes' fields flatten down (see [Class hierarchies](#class-hierarchies-extends--labels)) |
| Relationship `extends` / `abstract` | extra `LABEL … NO PROPERTIES` clauses on the sub-relationship's edge table; no edge table for an abstract relationship | a match on the parent label spans every descendant edge table (see [Relationship hierarchies](#relationship-hierarchies)) |
| Action | *nothing* | an action reaches Knowledge Catalog only (see below); the BigQuery push deploys none and warns once |
| Constraint | *nothing* | a constraint reaches Knowledge Catalog only (see below); the BigQuery push deploys none and warns once |

`push` reads the target dataset's location (`bigquery.datasets.get`) so the
statement runs in the right region; without that permission it falls back to
BigQuery's own location inference and warns. Under `--validate-only` no graph
DDL is executed and nothing is written (the live source-table checks still run —
see [Validation](#validation)); add `--print` to see the generated DDL.

**How a metric becomes a `MEASURE`.** A graph measure aggregates a node
property, so the aggregate's operand is exposed as one first. An operand that
is a single field aggregates that field's property directly
(`MEASURE(SUM(amount))`), even when a profile bound the field to a differently
named column. Any other operand is added as a derived property,
`<expr> AS <metric>_input`, and the measure aggregates that. A property
expression is evaluated against the table's physical columns, not the other
properties, so each field named in a compound operand is first replaced by the
column (or SQL) it is bound to, parenthesized when it is not a bare column:
`SUM(Opportunity.totalContractValue * Opportunity.probabilityOfWin)` under a
profile that binds `total_contract_value` and `probability_of_win` becomes
`total_contract_value * probability_of_win AS weighted_pipeline_input`. String
literals, function names, and qualified names are left untouched. Two metrics
whose operands resolve to the same SQL share one derived property.

For which of your descriptive metadata (`description`, `ai_context`, field
labels, …) lands in the graph and which is dropped, see
[What push and pull preserve](fidelity.md#to-bigquery).

### Only modeled properties are exposed

Every node and edge table lists exactly the properties the model declares, and
one with nothing to list says `NO PROPERTIES`. The push never leaves the
properties clause out: a label without one defaults to `PROPERTIES ARE ALL
COLUMNS`, which would expose every column of the backing table — modeled or
not — on the element. That matters most for a relationship. A foreign-key edge
is backed by its source entity's table, whose columns are that node's
properties, not the edge's, so the edge is emitted as:

```sql
`proj.ds.opportunity` AS hasBuyer
  KEY(opportunity_id)
  SOURCE KEY(opportunity_id) REFERENCES Opportunity(opportunity_id)
  DESTINATION KEY(client_id) REFERENCES Client(client_id)
  OPTIONS(description="…")
  NO PROPERTIES
```

Left to ALL COLUMNS, a physical column such as `won_amount` would appear on the
edge and collide with a metric of the same name on a node (BigQuery rejects it:
"Property 'won_amount' is defined as MEASURE, but there are other declarations
with the same name"). The same rule covers a node that declares only its key
and an M:N junction edge with no fields of its own. (Verified live.)

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
- **An empty label says `NO PROPERTIES`.** A label written with no properties
  clause means `PROPERTIES ARE ALL COLUMNS`. In a hierarchy that would expose
  every column of the table again under the label. Those copies clash with the
  properties the push renders explicitly on the same table, and BigQuery rejects
  the graph with `Property '<name>' has more than one definition in the element
  table`. So inside a hierarchy the push writes `NO PROPERTIES` for any label
  with nothing to list, on both backends. That covers an abstract root with no
  fields (a `BusinessObject` label on every node, for example), a supertype
  whose fields the subtype leaves unbound, and a subtype with no bound fields of
  its own. The labels still work for `MATCH (:BusinessObject)`. The same rule
  applies outside hierarchies (see [Only modeled properties are
  exposed](#only-modeled-properties-are-exposed)).

An entity marked **`abstract: true`** is a conceptual class with no physical
table: it has no `source` and no key, produces **no node table**, and survives
only as a `LABEL` on its concrete descendants. Its field names still flatten
down, and each concrete subtype supplies the column for each of those names, so
the shared label's signature is present on every subtype table. An abstract
entity that no concrete entity extends has nothing to attach to and is dropped
with a warning. `abstract` is an explicit marker: a non-abstract entity with no
`source` is treated as a binding error and fails the push, never
silently dropped as if it were table-less. On Knowledge Catalog an abstract
entity is published as a table-less `semantic-entity` entry, and each subtype's
entry names its supertypes (see [Class hierarchies on the
catalog](#class-hierarchies-on-the-catalog)).

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

### Relationship hierarchies

A relationship may `extends: [Rel, …]` other relationships, and a relationship
may be `abstract: true` (both `/google` extensions; see [Relationship
inheritance](inheritance.md#relationship-inheritance)). Edge labels are resolved
like node labels:

- **An abstract relationship emits no `EDGE TABLE`.** It keeps `from`/`to` but
  must not declare `from_columns`/`to_columns` (the loader rejects it), and push
  does not require join columns of it. One that nothing extends is warned.
- **A concrete edge in a hierarchy** is emitted as `DEFAULT LABEL`, then its
  `OPTIONS` (BigQuery), then its properties clause (`NO PROPERTIES` for a
  foreign-key edge), then `LABEL <ancestor> NO
  PROPERTIES` for every transitive ancestor, nearest first, de-duplicated.
  Ancestor labels carry no properties, so edge tables over different source
  tables share the label without agreeing on columns — `MATCH
  ()-[:Ancestor]->()` spans all of them.
- **A concrete relationship that others extend** is emitted with `DEFAULT
  LABEL` and `NO PROPERTIES`, the only property signature compatible with its
  children's; its `OPTIONS` are dropped with a warning (BigQuery rejects
  `OPTIONS` on a label that other tables also define). An edge present in its
  table and a child's table is matched twice under its label.
- **Edges outside any hierarchy are unchanged** — no `LABEL` clause.
- **The loader warns** on a dangling parent, a cyclic `extends` chain, and a
  child whose `from`/`to` is neither the parent's end nor a subtype of it (per
  entity `extends`). Push rejects a dangling parent unless the model was pruned
  by a profile.
- **Knowledge Catalog.** An abstract relationship publishes no `schema-join`
  link (warned). A concrete one appends `Specializes: <parent>, ….` to its join
  description — the only free text in the closed `schema-join` template. On
  pull that line is stripped and each parent that resolves to a pulled
  relationship becomes `extends` again (under its pulled, link-slugged name). A
  parent with no link of its own — every abstract parent — cannot be recovered
  and is dropped with a warning, so an abstract relationship does not
  round-trip through the catalog.

### Relationship inverses (`inverse`)

A relationship is directed, but a question often reads it the other way — "the
opportunities of this client" over `hasBuyer` (Opportunity → Client). Name that
reading with `inverse:` (`/google` profile) rather than declaring a second
relationship; it is the native home of OWL `owl:inverseOf` (see [Inverse
properties](owl-import.md#inverse-properties-owlinverseof)):

```yaml
relationships:
  - name: hasBuyer
    from: Opportunity
    to: Client
    from_columns: [client_id]
    to_columns: [client_id]
    inverse: hasOpportunity      # Client -[hasOpportunity]-> Opportunity
```

The push emits the inverse as a **second edge table over the same backing
table**, with `SOURCE` and `DESTINATION` swapped and the inverse name as its
label. There is one set of rows and one join; only the direction label differs:

```sql
`proj.ds.opportunity` AS hasBuyer
  KEY(opportunity_id)
  SOURCE KEY(opportunity_id) REFERENCES Opportunity(opportunity_id)
  DESTINATION KEY(client_id) REFERENCES Client(client_id)
  NO PROPERTIES,
`proj.ds.opportunity` AS hasOpportunity
  KEY(opportunity_id)
  SOURCE KEY(client_id) REFERENCES Client(client_id)
  DESTINATION KEY(opportunity_id) REFERENCES Opportunity(opportunity_id)
  NO PROPERTIES
```

so both `MATCH (o)-[:hasBuyer]->(c)` and `MATCH (c)-[:hasOpportunity]->(o)`
resolve. (BigQuery accepts two edge tables over one backing table — the DDL
above deploys, verified live.) The rules:

- **One name, no second definition.** The inverse carries no columns,
  description, or synonyms of its own; the relationship's `OPTIONS` stay on the
  forward label only, and an M:N inverse shares the junction's properties.
- **Unique across the graph.** The inverse becomes an element alias, so it must
  differ (case-insensitively) from every entity, relationship, and other
  inverse name, and from its own relationship's name; the loader rejects a
  clash. An IR that reaches the push some other way (a Knowledge Catalog pull)
  has the clashing inverse omitted with a warning instead.
- **Spanner Graph** emits the same pair of edge tables.
- **Hierarchies.** The reversed edge carries only its own label: the
  relationship's ancestor labels name the forward direction, so they are not
  repeated on it. An abstract relationship emits no edge table, so its
  `inverse` is not emitted either (warned).
- **Knowledge Catalog** has no inverse slot on a `schema-join` link, so the
  push appends an `Inverse: <name>.` trailer to the link's description, and
  pull strips it back into `inverse:` (a description that ends that way is read
  as an inverse).

## What gets created in Spanner

When the deployment target is a Spanner Graph URI, `push` executes the same
`CREATE OR REPLACE PROPERTY GRAPH` — but generated for Spanner Graph, which
differs from BigQuery Graph in four ways:

| Model element | Spanner construct | Notes |
|---|---|---|
| Model | `PROPERTY GRAPH` | named by the URI's `propertyGraphs/<g>` segment, **bare** (no backticked `project.dataset.` prefix) |
| Entity | `NODE TABLE` | backed by the entity's `source` reduced to its final segment (`proj.ds.Orders` → `Orders`), a table in the target database |
| Relationship | `EDGE TABLE` | connects the two entities' node tables |
| Relationship `inverse` | a second `EDGE TABLE` over the same table | `SOURCE`/`DESTINATION` swapped, as on BigQuery (see [Relationship inverses](#relationship-inverses-inverse)) |
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

The rule that [only modeled properties are
exposed](#only-modeled-properties-are-exposed) applies unchanged: an element
table with nothing to list says `NO PROPERTIES` rather than default to all
columns (not yet verified live on Spanner).

Under `--validate-only` nothing is applied; add `--print` to see the generated
Spanner DDL. Unlike the BigQuery leg, a Spanner-targeting model's source tables
are **not** probed before deploy. Its actions are: every `sql` executor
statement is planned against the target database first, on both legs (see
[Validation](#validation)).

## What gets created in Knowledge Catalog

Each element of your model maps to one catalog resource. Every resource type
below except `semantic-action` and `semantic-constraint` is a built-in system
type under `dataplex-types/global` — push references them, it never creates
them. Those two are custom, and `kcmd init --semantic-model` creates them in
your own project at `global`; push still writes only entries.

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

### Class hierarchies on the catalog

An **abstract** entity (a table-less supertype) is published like any unbound
logical entity: a `semantic-entity` entry with an empty `source.resources`, its
own fields in the `schema` aspect, and no `primaryKey`. The supertype is then a
catalog entry an agent can find and read — its description, fields and
guidelines — and an action or constraint that names it points at a published
concept.

Neither entity template has a slot for a supertype or for "no table", so both
ride the entry description as fixed trailing paragraphs — readable to a person
or an agent browsing the catalog, and parseable by `pull`:

```text
A buying party.

Specializes: Party.
```

```text
Anyone we do business with.

Abstract: no table of its own.
```

`pull` peels them off and restores `extends` and `abstract`, so the pulled model
loads strictly (an abstract entity needs no `source`; a non-abstract one does).
The `Abstract:` marker is what tells the two apart — an unbound logical entity
publishes the same empty `resources`. A parent that the pull did not recover is
dropped from `extends` with a warning. Two limits: inherited fields are not
flattened onto a subtype's entry (each entry lists the fields it declares), and
a relationship with an abstract endpoint publishes no `schema-join` link, since
there are no columns behind that end.

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

Before these checks even run, the document must **load**, and the loader is strict:
`version` is required and must be `0.2.0.dev0` (vanilla Ossie) or
`0.2.0.dev0/google` (the extended profile); every object is closed, so an unknown
key — including a native key under vanilla, or a `custom_extensions` block under
`/google` — is rejected; names must be unique within their scope; and every
`extends` must name an entity defined in the model. A load failure is reported the
same way as a validation failure — nothing is touched, non-zero exit — and is
defined in [model spec §1](model_spec.md#1-status-and-baseline),
[§2](model_spec.md#2-document-shape), [§6](model_spec.md#6-the-extension-mechanism),
and [§4.1](model_spec.md#41-narrowings-stricter-than-ossie).

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
  exactly as the deploy will — a three-part `project.dataset.table`, a four-part
  federated REST-catalog name (e.g. an Iceberg table via BigLake), or a quoted
  identifier all work. A table that does not exist or that you cannot access fails
  the push, naming the table and the entity; a `source` that is a query (not a
  table) is skipped. A **Spanner-targeting** model's sources live in Spanner
  (a different system) and are **not** probed here. The `source` construct and its
  URI/dotted forms are defined in [model spec §7.1](model_spec.md#71-table-sources).
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
  `dataplex.entryTypes.create` — the custom `semantic-action` and
  `semantic-constraint` pairs. Init patches an aspect type that is already
  there, so a project set up by an older `kcmd` picks up template additions; an
  entry type that is already there is left alone.

Only the entry-group permission is required. Actions and constraints are
optional constructs, so init reports a refusal to create their types as a
warning and carries on; every model that declares neither still pushes and
pulls. Any other failure to create a type stops init, rather than leaving a
later push to hit an opaque parsing error.

`kcmd pull` needs read access to the same entry group instead — to list its
entries and fetch each `semantic-*` entry with its aspects.
