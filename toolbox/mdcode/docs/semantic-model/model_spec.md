# Semantic Model Specification

This is the normative definition of the semantic model document `kcmd` reads and
writes. It defines what a *valid* model is — the YAML grammar, the logical and
physical constructs, and the rules the format enforces. For what `kcmd` *does*
with a valid model (flags, what each push creates, permissions), see
[Reference](reference.md); for the task walkthrough, see the
[deploy guide](README.md).

The two documents divide by register: this spec states the **definition**
("a model MUST declare at most one deployment target"); Reference states the
**operational consequence** ("…otherwise push is rejected"), and links back here.
When they overlap, this document is the authority on what is valid and Reference
is the authority on what the tool then does.

## 1. Status and baseline

The format is **`kcmd`'s profile of [Apache Ossie](https://ossie.apache.org/)**,
pinned to Ossie version **`0.2.0.dev0`**. Ossie is the open semantic-model format:
it describes a business — datasets, fields, relationships, metrics — *and* binds
each dataset to a `source` table and each field to a column `expression`. What
Ossie does not describe is where a model then deploys. This profile is a superset:
it adds that deployment layer and a few modeling constructs, and it relaxes a few
of Ossie's required fields so a model can stay purely logical.

The compatibility contract runs in both directions, and they are not symmetric:

> **Every Ossie `0.2.0.dev0` document is a valid `kcmd` model.** The reverse holds
> for a `kcmd` model that uses no extensions ([§5](#5-extensions)) *and* no
> relaxations ([§4](#4-narrowings-and-relaxations)) — i.e. a fully-bound model with only Ossie
> constructs. Strip the extensions from such a model and it is a valid Ossie
> document.

The goal is full Ossie compatibility. Every `kcmd`-specific construct is carried
in a way an Ossie-only tool ignores (see [§6](#6-the-extension-mechanism)), so the
two never fork the document.

**How to read this document.** This is a *delta* against the Ossie spec. It does
not restate constructs `kcmd` adopts unchanged — for those, the Ossie spec is
authoritative. This document covers only what is `kcmd`'s to state:

1. where `kcmd` is **stricter** than Ossie — narrowings ([§4](#4-narrowings-and-relaxations)),
2. where `kcmd` is **looser** than Ossie — relaxations ([§4](#4-narrowings-and-relaxations)),
3. what `kcmd` **adds** beyond Ossie — extensions ([§5](#5-extensions)), and
4. how those additions stay Ossie-compatible ([§6](#6-the-extension-mechanism)).

If a construct is not mentioned here, `kcmd` supports it as Ossie `0.2.0.dev0`
defines it.

**Conformance keywords.** MUST, MUST NOT, SHOULD, and MAY are used per
[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119). A rule marked MUST is enforced
at load or validation time; the exact operational effect (hard error, skip with a
warning) is in [Reference → Validation](reference.md#validation).

**Version handling.** `version` is optional and lives at the top of the document
(not inside a model). A document whose `version` differs from `0.2.0.dev0` loads
anyway with a warning; the profile does not gate on it. Authored documents SHOULD
set `version: "0.2.0.dev0"`.

**Baseline.** The Ossie classifications in [§3](#3-conformance-summary) are
reconciled against the Ossie `0.2.0.dev0` core JSON Schema, a copy of which is
vendored in this repository at
`tests/libts/semantic/fixtures/ossie/osi-schema.json` (copied unmodified from
`apache/ossie`). That schema, not `kcmd`'s parser, is the authority for what Ossie
defines; the parser is the authority only for what `kcmd` accepts.

## 2. Document shape

A model document is a YAML file with a top-level `semantic_model` list.

```yaml
version: "0.2.0.dev0"          # optional; see §1
semantic_model:                # one or more models; kcmd deploys exactly one per entry group (§4)
  - name: sales
    datasets: [ … ]            # one or more; the entities (§2.1). `entities:` is an accepted alias (§5)
    relationships: [ … ]       # optional (§2.2)
    metrics: [ … ]             # optional (§2.3)
    description: "…"           # optional
    ai_context: { … }          # optional (§2.4)
    custom_extensions: [ … ]   # optional (§6)
    deployment_target: "…"     # optional; physical binding (§5, §7)
```

A document MUST contain at least one model, and each model MUST contain at least
one dataset. Every named object (dataset, field, relationship, metric) SHOULD
have a name unique within its scope; a duplicate loads with a warning and produces
an invalid graph.

Objects are **open**: an unknown sibling key inside a validated object is silently
dropped, not an error. The two exceptions are the sugar conflicts in
[§5](#5-extensions) (setting both `entities` and `datasets`, or a
`deployment_target` that disagrees with an existing `GOOGLE` extension), which are
hard errors.

The remaining subsections define each object. Names throughout are **logical
business vocabulary** — `order_id`, `placed_by` — never physical column names; the
physical binding is a separate concern ([§7](#7-the-binding-layer)).

### 2.1. Dataset (entity)

A dataset is one concept in the business.

| Key | Type | Rule |
|---|---|---|
| `name` | string | required |
| `fields` | list of [field](#211-field) | the concept's attributes |
| `primary_key` | list of strings | the field(s) that identify a row |
| `unique_keys` | list of lists of strings | additional unique column-sets |
| `extends` | list of strings | supertype dataset names — extension ([§2.1.2](#212-inheritance-extends), [§5](#5-extensions)) |
| `abstract` | boolean | a concept with no table — extension ([§5](#5-extensions)) |
| `source` | string | physical table URI; Ossie-native, relaxed to optional ([§7.1](#71-table-sources), [§4](#4-narrowings-and-relaxations)) |
| `description` | string | |
| `ai_context` | [ai_context](#24-ai_context) | |
| `custom_extensions` | list | [§6](#6-the-extension-mechanism) |

An abstract dataset MUST NOT declare a `source`; a non-abstract dataset in a model
bound for a graph MUST declare one (see [§4](#4-narrowings-and-relaxations) and
[§7](#7-the-binding-layer)).

#### 2.1.1. Field

| Key | Type | Rule |
|---|---|---|
| `name` | string | required |
| `datatype` | enum | one of the closed vocabulary below |
| `expression` | [expression](#25-expressions) | physical-column binding (binding — [§7](#7-the-binding-layer)) |
| `unbound` | boolean | this binding has no column for the field (binding — [§7](#7-the-binding-layer)) |
| `label` | string | human display label |
| `dimension` | object | `{ is_time: boolean }` |
| `description` | string | |
| `ai_context` | [ai_context](#24-ai_context) | |
| `custom_extensions` | list | [§6](#6-the-extension-mechanism) |

`datatype` is a closed, **case-sensitive** vocabulary:

```
String  Integer  Decimal  Float  Boolean  Date  Time  DateTime  DateTimeTz  Opaque
```

`Date`, `Time`, `DateTime`, and `DateTimeTz` are the temporal subset (they default
`dimension.is_time`). A value outside this set is not authorable directly; a type
`kcmd` cannot express natively is represented as `Opaque` plus a `custom_extensions`
block that carries the real type.

`expression` and `unbound` are the field's binding and are mutually exclusive; see
[§7](#7-the-binding-layer).

#### 2.1.2. Inheritance (`extends`)

`extends` is a `kcmd` **extension** — Ossie `0.2.0.dev0` has no inheritance
construct ([§5](#5-extensions)). A dataset MAY declare `extends: [Parent, …]`,
naming one or more supertype datasets by name. Inheritance is **entity-level
only** — relationships do not `extends`. A supertype that has no table of its own
MUST be marked `abstract: true` (also an extension).

The format rule is only that supertypes are named datasets in the same model. The
resolver breaks cycles with a warning and flattens diamonds (each ancestor
contributes once, nearest-first); an unknown supertype is ignored with a warning.
How the hierarchy is *lowered* into each store (labels, field flattening) and the
downstream limits (e.g. a supertype whose label is shared across subtype tables
cannot carry a measure) are operational — see
[Reference → Class hierarchies](reference.md#class-hierarchies-extends--labels)
and [Modeling class hierarchies](inheritance.md).

### 2.2. Relationship

A relationship is a directed edge between two datasets.

| Key | Type | Rule |
|---|---|---|
| `name` | string | required |
| `from` | string | required; a declared dataset name |
| `to` | string | required; a declared dataset name |
| `from_columns` | list of strings | join key on `from` |
| `to_columns` | list of strings | join key on `to` |
| `description` | string | |
| `ai_context` | [ai_context](#24-ai_context) | |
| `custom_extensions` | list | [§6](#6-the-extension-mechanism) |

`from_columns` and `to_columns` are the edge's join keys. They MUST be given
together (a bound edge) or both omitted (a logical edge); one without the other is
rejected. When both are given they MUST have equal length. `from` and `to` MUST
name datasets declared in the same model.

Ossie **requires** both join-column lists; allowing both to be omitted — a
logical edge with no join keys — is a `kcmd` **relaxation** ([§4](#4-narrowings-and-relaxations))
that lets a relationship be governed before it is bound. A graph deploy still
requires them (see [§4](#4-narrowings-and-relaxations)). Unlike `source` and field `expression`,
join columns are declared on the logical model and are not profile-swappable
([§7](#7-the-binding-layer)).

> **Many-to-many is not yet authorable.** A junction-table (M:N) relationship
> exists in `kcmd`'s internal representation but has **no YAML syntax** in
> `0.2.0.dev0`. It cannot be authored today and is reserved for a future format
> extension. Direct-FK relationships (1:1, 1:N) are the authorable forms.

### 2.3. Metric

A metric is a computation over the model's fields.

| Key | Type | Rule |
|---|---|---|
| `name` | string | required |
| `expression` | [expression](#25-expressions) | **required** |
| `datatype` | enum | the [field datatype vocabulary](#211-field) |
| `description` | string | |
| `ai_context` | [ai_context](#24-ai_context) | |
| `custom_extensions` | list | [§6](#6-the-extension-mechanism) |

A metric names no dataset directly; the dataset it belongs to is **derived** from
the entities its expression references. This is why a metric bound for a BigQuery
graph MUST reduce to a single entity ([§4](#4-narrowings-and-relaxations)). A metric is SQL over
fields; there is no native metric-composition (metric-of-metrics) construct.

### 2.4. `ai_context`

`ai_context` MAY appear on the model, a dataset, a field, a relationship, and a
metric. It is either a bare string (shorthand for instructions) or an object:

```yaml
ai_context:
  instructions: "…"        # guidance for agents
  synonyms: [ "…", "…" ]   # alternate names
  examples: [ … ]          # illustrative values / usages
```

There is no top-level `synonyms` key on any object; synonyms are always
`ai_context.synonyms`. `instructions`, `synonyms`, and `examples` are all
Ossie-native. `kcmd` accepts `examples` leniently — items of any shape, keeping
only the string ones — where Ossie constrains items to strings; authored documents
SHOULD use string examples for portability. Which parts of `ai_context` reach
which destination is in [What push and pull preserve](fidelity.md).

### 2.5. Expressions

A field or metric `expression` is either a bare SQL string or the per-dialect
form:

```yaml
expression: SUM(orders.net_amount)        # shorthand: dialect BIGQUERY

expression:                               # explicit per-dialect
  dialects:
    - { dialect: BIGQUERY, expression: "SUM(orders.net_amount)" }
    - { dialect: ANSI_SQL, expression: "SUM(orders.net_amount)" }
```

The shorthand string normalizes to a single `BIGQUERY` dialect. `ANSI_SQL` is the
portable fallback. An `expression` references logical fields as
`entity.field`; the qualifiers are what let a metric's entity be derived
([§2.3](#23-metric)).

Ossie closes `dialect` to an enum — `ANSI_SQL`, `SNOWFLAKE`, `MDX`, `TABLEAU`,
`DATABRICKS`, `MAQL`, `BIGQUERY`, `THOUGHTSPOT`. `kcmd`'s parser accepts any
string here (a relaxation); authored documents SHOULD use an Ossie dialect name.

## 3. Conformance summary

Every construct, at a glance. **In Ossie?** is whether Ossie `0.2.0.dev0` defines
it (per the vendored core schema — see [§1](#1-status-and-baseline)). **kcmd
status** is this profile's relationship to it: *as-is* (adopted unchanged),
*relaxed* (accepted but looser than Ossie, [§4](#4-narrowings-and-relaxations)), *narrowed*
(accepted but stricter, [§4](#4-narrowings-and-relaxations)), *extension* (added by `kcmd`,
[§5](#5-extensions)), or *reserved* (recognized internally, not authorable in
`0.2.0.dev0`).

| Construct | In Ossie? | kcmd status | Where |
|---|---|---|---|
| `semantic_model`, `name`, `description` | yes | as-is | [§2](#2-document-shape) |
| `datasets` | yes | as-is | [§2.1](#21-dataset-entity) |
| `entities` (alias for `datasets`) | no | extension (alias) | [§5](#5-extensions) |
| field `name`, `label`, `dimension` (`is_time`) | yes | as-is | [§2.1.1](#211-field) |
| `datatype` + its vocabulary | yes | as-is (identical, closed) | [§2.1.1](#211-field) |
| `primary_key`, `unique_keys` | yes | as-is | [§2.1](#21-dataset-entity) |
| `extends` | no | extension | [§2.1.2](#212-inheritance-extends), [§5](#5-extensions) |
| `abstract` | no | extension | [§5](#5-extensions) |
| relationship `name`, `from`, `to` | yes | as-is | [§2.2](#22-relationship) |
| relationship `from_columns` / `to_columns` | yes (required) | relaxed to optional | [§2.2](#22-relationship), [§4](#4-narrowings-and-relaxations) |
| relationship M:N (`association`) | no | reserved (IR only) | [§2.2](#22-relationship) |
| `metrics`, metric `expression` (required) | yes | as-is; graph-bound narrowed | [§2.3](#23-metric), [§4](#4-narrowings-and-relaxations) |
| `expression.dialects` | yes (closed enum) | as-is; `dialect` string relaxed | [§2.5](#25-expressions) |
| field `expression` (column binding) | yes (required) | relaxed to optional | [§7](#7-the-binding-layer), [§4](#4-narrowings-and-relaxations) |
| `source` (dataset table binding) | yes (required) | relaxed to optional | [§7.1](#71-table-sources), [§4](#4-narrowings-and-relaxations) |
| `unbound` (field) | no | extension | [§5](#5-extensions), [§7](#7-the-binding-layer) |
| `ai_context` (`instructions`, `synonyms`, `examples`) | yes | as-is (`examples` relaxed) | [§2.4](#24-ai_context) |
| `custom_extensions` (`vendor_name`, `data`) | yes | as-is (mechanism) | [§6](#6-the-extension-mechanism) |
| `deployment_target` | no | extension | [§5](#5-extensions), [§7.2](#72-deployment-target) |
| binding profiles | no | extension | [§7.3](#73-binding-profiles) |
| single model per entry group | — | narrowed | [§4](#4-narrowings-and-relaxations) |

## 4. Narrowings and relaxations

`kcmd` diverges from Ossie in two directions. **Narrowings** are where `kcmd` is
stricter — rules that can reject an otherwise-valid Ossie document at deploy time.
**Relaxations** are where `kcmd` is looser — fields Ossie requires that `kcmd`
makes optional, so a relaxed `kcmd` model is not a valid Ossie document until those
fields are supplied. Both are the reason the reverse compatibility direction in
[§1](#1-status-and-baseline) is conditional.

### 4.1. Narrowings (stricter than Ossie)

Each rule and its reason:

- **At most one deployment target per model.** A model bound for a graph MUST
  declare exactly one deployment target ([§7](#7-the-binding-layer)). *Why:* the
  target names one graph in one store; a model with several has no single place to
  deploy. (A catalog-only push needs no target at all.)

- **Exactly one model per entry group.** A push MUST deploy exactly one model to a
  Knowledge Catalog entry group, and a pull expects exactly one. *Why:* the entry
  group is the model's identity in the catalog; more than one anchor is ambiguous.

- **A graph-bound metric MUST resolve to a single entity.** For a BigQuery target,
  every metric's expression MUST reference exactly one entity, so the metric can
  attach to one node table. *Why:* a graph measure binds to a single element.
  Spanner imposes no such rule (it has no measures). A metric that resolves to no
  entity or spans several is rejected/skipped at emit.

- **A graph-bound metric SHOULD reduce to one supported aggregate.** For a
  BigQuery target, a metric that is not a single supported aggregate
  (`SUM`, `AVG`, `COUNT`, `MIN`, `MAX`) over one operand — with `COUNT(*)` over a
  keyed node the one special case — cannot become a `MEASURE` and is skipped with
  a warning. *Why:* BigQuery Graph measures are single-aggregate. This is a SHOULD,
  not a MUST: the metric still reaches Knowledge Catalog; it simply has no graph
  measure.

- **A graph-bound relationship MUST have its join columns bound.** For any graph
  target, a non-M:N relationship MUST supply both `from_columns` and `to_columns`
  before deploy. *Why:* the edge table needs both keys.

Not a narrowing, contrary to a common assumption: **diamonds in a class hierarchy
are not rejected.** The resolver flattens them (each ancestor once) and breaks
cycles with a warning. What *is* rejected is downstream and store-specific — a
BigQuery `MEASURE` cannot bind to a label shared across subtype tables. See
[§2.1.2](#212-inheritance-extends).

### 4.2. Relaxations (looser than Ossie)

`kcmd` relaxes Ossie in two kinds, for two different reasons.

**Binding fields made optional — to model before binding.** Ossie marks these
required; `kcmd` accepts them as optional so a model can be governed before it is
bound (a purely *logical* model). A graph deploy still requires each one — that
requirement is the corresponding narrowing in
[§4.1](#41-narrowings-stricter-than-ossie).

- **`source` on a dataset** — required in Ossie; optional in `kcmd`. A non-abstract
  dataset bound for a graph MUST still declare one.
- **`expression` on a field** — required in Ossie; optional in `kcmd` (mark the
  field `unbound`, or supply the column in a binding profile).
- **`from_columns` / `to_columns` on a relationship** — both required in Ossie;
  `kcmd` allows both omitted (a logical edge).

**Value constraints loosened — to tolerate imported and future inputs.** Ossie
closes these to a fixed set; `kcmd`'s parser accepts more so a document produced by
an importer or by a newer Ossie is loaded (with a warning), not rejected, then
normalized on the way to a store. *Why:* these carry no deploy-time meaning that a
stricter check would protect — an unknown `dialect` is only ever selected against a
known one, and a non-string example is discarded — so rejecting the whole document
over them costs portability for no safety. Authored documents SHOULD still use the
Ossie-valid forms.

- **`dialect` value** — a closed enum in Ossie; any string in `kcmd`'s parser
  (an unrecognized dialect is ignored when a canonical variant is selected).
- **`ai_context.examples` items** — strings in Ossie; any shape in `kcmd`
  (non-strings are dropped on load).

The operational form of every rule in this section (hard error vs.
skip-with-warning, and the exact message) is in
[Reference → Validation](reference.md#validation).

## 5. Extensions

Constructs `kcmd` adds beyond Ossie. Each is carried so an Ossie-only tool still
reads the document ([§6](#6-the-extension-mechanism)).

- **`entities` as an alias for `datasets`.** A model MAY spell its datasets
  `entities:` instead of `datasets:`. Setting both is an error. Pure sugar —
  identical meaning.

- **`extends` on a dataset.** Class inheritance — a subtype names its supertype
  datasets. Ossie `0.2.0.dev0` has no inheritance construct. See
  [§2.1.2](#212-inheritance-extends).

- **`abstract: true` on a dataset.** Marks a concept with no physical table
  (typically an `extends` supertype). An abstract dataset produces no node table
  and MUST NOT declare a `source`.

- **`deployment_target`.** The physical destination — one graph in one store — as
  a first-class model-level (or profile-level) key. It folds into a `GOOGLE`
  `custom_extensions` block ([§6](#6-the-extension-mechanism)); the block is the
  wire form an Ossie-only reader passes through untouched. Grammar in
  [§7](#7-the-binding-layer).

- **Binding profiles.** A separate document that supplies only the physical
  bindings, so one logical model serves several stores. Not part of the Ossie
  document; a `kcmd`-specific file alongside it ([§7](#7-the-binding-layer)).

- **`unbound: true` on a field.** Declares that a given binding has no column for
  the field. A binding-layer concept ([§7](#7-the-binding-layer)); mutually
  exclusive with `expression`.

Deliberately **not** extensions in `0.2.0.dev0`, to avoid the impression they
exist: there is **no `actions` block** and **no authorable M:N `association`
syntax**. Both are reserved for future consideration; neither is part of the
format today.

## 6. The extension mechanism

Every `kcmd` extension rides in Ossie's own **`custom_extensions`** carrier, which
is why the profile stays a superset. A `custom_extensions` entry is:

```yaml
custom_extensions:
  - vendor_name: GOOGLE       # the namespace
    data: "{ … }"             # an opaque, vendor-serialized string (typically JSON)
```

`custom_extensions` MAY appear on the model, a dataset, a field, a relationship,
and a metric. `data` is opaque at the format level: nothing is interpreted when
the document is parsed, and it round-trips verbatim. An Ossie-only tool treats a
`GOOGLE` block as a vendor extension it does not recognize and passes it through
unchanged — so a `kcmd` model is still a valid Ossie document, and stripping the
`GOOGLE` blocks yields plain Ossie.

**Native key + `GOOGLE` mirror.** Where a `kcmd` extension has a readable
first-class spelling, that spelling is *sugar* over a `GOOGLE` block. The
`deployment_target:` key is the example: it folds into a
`GOOGLE` block carrying `{"deploymentTargets": ["…"]}`, which is the form the
deploy path actually reads. Both forms are accepted and mean the same thing; if a
document sets both and they disagree, that is a hard error. This lets authors
write the readable key while the document on the wire stays plain Ossie plus one
opaque vendor block.

Extensions with no first-class spelling (for example the OWL constructs the OWL
importer carries) live directly in `custom_extensions` and survive the document
round-trip verbatim, even though they are inert on deploy today. What each such
block does or doesn't reach is in
[What push and pull preserve](fidelity.md).

## 7. The binding layer

Ossie already binds a model to physical data: a dataset names a `source` table, a
field names a column `expression`, and a relationship names its join columns. Those
are Ossie-native, not `kcmd` additions. What `kcmd` adds is the layer that says
**where a model deploys** and lets **one logical model serve several stores**:

- **`deployment_target` on the model** — where the model deploys. A `kcmd`
  extension; Ossie has no deployment construct ([§7.2](#72-deployment-target)).
- **binding profiles** — a separate document that varies the physical bindings
  per store. A `kcmd` extension ([§7.3](#73-binding-profiles)).
- **`unbound` on a field** — a field with no column under a given binding. A
  `kcmd` extension.

`kcmd` also **relaxes** the Ossie-native bindings — `source`, field `expression`,
and relationship join columns — from required to optional ([§4.2](#42-relaxations-looser-than-ossie)),
so a model with none of them is a complete *logical* model that can be governed in
Knowledge Catalog as-is. The bindings are required only to deploy to a store.

The physical bindings divide by what a profile can move. **`source` and a field's
`expression` are profile-swappable**: a [binding profile](#73-binding-profiles)
supplies or overrides them, so one logical model deploys to several stores. **A
relationship's join columns are not** — they are declared on the logical model and
a profile MUST NOT set them ([§7.3](#73-binding-profiles)), so they are fixed for
every binding of the model. In practice this holds because join keys are usually
stable across stores even when table and column names differ; a store that needs
different join keys needs a different logical model.

### 7.1. Table sources

`source` is a resource URI naming the backing table:

```
//bigquery.googleapis.com/projects/<p>/datasets/<d>/tables/<table>
//spanner.googleapis.com/projects/<p>/instances/<i>/databases/<db>/tables/<table>
```

For BigQuery a dotted shorthand is also accepted: `dataset.table` (qualified with
the scope's project) or `project.dataset.table`; a name with more than three parts
points at a table in a federated REST catalog. Ossie requires `source` on every
dataset; `kcmd` relaxes it to optional ([§4.2](#42-relaxations-looser-than-ossie))
so a purely logical model loads, but a non-abstract dataset in a model bound for a
graph MUST have one.

### 7.2. Deployment target

`deployment_target` is a single resource URI whose host selects the store:

```
# BigQuery Graph — analytical
//bigquery.googleapis.com/projects/<p>/datasets/<d>/propertyGraphs/<g>

# Spanner Graph — operational
//spanner.googleapis.com/projects/<p>/instances/<i>/databases/<db>/propertyGraphs/<g>
```

The URI MUST match one of these two shapes. A model bound for a graph MUST declare
exactly one ([§4](#4-narrowings-and-relaxations)). The identifier segments are restricted to
`[A-Za-z0-9_-]`. As [§6](#6-the-extension-mechanism) notes, the key is sugar over
a `GOOGLE` `custom_extensions` block; both forms mean the same thing.

### 7.3. Binding profiles

A **binding profile** is a separate document that supplies only the physical
bindings for a model, so one logical model can deploy to several stores from one
definition. A profile:

- is a `semantic_model` document in the **same schema** as the logical model, but
  MUST set only physical-binding keys: at the model level `deployment_target` and
  `datasets`/`entities`; at the dataset level `source` and `fields`; at the field
  level `expression` and `unbound`. Setting any logical key (a new field,
  `primary_key`, a relationship, …) in a profile is an error — the logical model
  owns those.
- binds by `name` at each level. A field a profile omits is treated as `unbound`
  for that profile.
- MUST express a field `expression` as a **bare column reference**, not arbitrary
  SQL — the computation belongs to the logical model.

The model document lives at `catalog/EntryGroups/<entryGroup>/<model>.yaml`
(sidecar files `*.aspects.yaml` / `*.overview.yaml` are not models). Profiles live
alongside it at `catalog/EntryGroups/<entryGroup>/<model>.profiles/<name>.yaml`;
the profile's name is the file's basename. The name `default` is reserved for the
model's own inline bindings and MUST NOT be used as a profile file. A
`default_profile` in `catalog.yaml` selects which profile the default push uses.
The full merge behavior and worked examples are in
[Binding profiles](profiles.md).

## 8. Versioning and compatibility policy

- **What pinning `0.2.0.dev0` guarantees.** The constructs in [§2](#2-document-shape)
  and the extensions in [§5](#5-extensions) are what `kcmd` reads and writes at
  this version. `version` is advisory: a document at another version loads with a
  warning, so pinning is a statement of intent, not a gate.

- **When Ossie changes.** A new Ossie construct is added to
  [§3](#3-conformance-summary) as a row — *as-is* if adopted unchanged, *narrowed*
  if constrained. Growth is a table entry, not a rewrite; this document's size
  tracks `kcmd`'s decisions, not Ossie's surface.

- **Forward direction of each extension.** An extension is either a candidate to
  upstream into Ossie (the readable-key extensions, e.g. `deployment_target`) or
  intended to stay a `GOOGLE` `custom_extensions` block indefinitely (Google-store
  specifics). Until an extension is upstreamed it MUST keep its `GOOGLE`-carried
  form so the superset contract in [§1](#1-status-and-baseline) holds.

- **Reserved constructs.** `association` (M:N) and any `actions`-like write-side
  construct are reserved: recognized as future work, not authorable today. A
  document MUST NOT rely on either in `0.2.0.dev0`.

## Appendix: annotated example

A logical model plus one binding profile.

```yaml
# catalog/EntryGroups/sales/sales.yaml — the logical model (concepts + edge join keys;
# table and column bindings live in the profile below — see §7)
version: "0.2.0.dev0"
semantic_model:
  - name: sales
    datasets:
      - name: orders
        primary_key: [order_id]
        fields:
          - { name: order_id,   datatype: Integer }
          - { name: net_amount, datatype: Decimal, label: "Net amount" }
      - name: customer
        primary_key: [customer_id]
        fields:
          - { name: customer_id, datatype: Integer }
          - { name: name,        datatype: String }
        ai_context:
          synonyms: [client, account]
    relationships:
      - name: placed_by
        from: orders
        to: customer
        from_columns: [customer_id]
        to_columns: [customer_id]
    metrics:
      - name: revenue
        expression: SUM(orders.net_amount)   # resolves to one entity → a BigQuery measure
```

```yaml
# catalog/EntryGroups/sales/sales.profiles/analytical.yaml — physical binding only
version: "0.2.0.dev0"
semantic_model:
  - name: sales
    deployment_target: "//bigquery.googleapis.com/projects/acme/datasets/sales/propertyGraphs/sales"
    datasets:
      - name: orders
        source: acme.raw.orders
        fields:
          - { name: order_id,   expression: o_id }
          - { name: net_amount, expression: o_net }
      - name: customer
        source: acme.raw.customer
        fields:
          - { name: customer_id, expression: c_id }
          - { name: name,        expression: c_name }
```
