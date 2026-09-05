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
built on Ossie version **`0.2.0.dev0`**. Ossie is the open semantic-model format:
it describes a business — datasets, fields, relationships, metrics — *and* binds
each dataset to a `source` table and each field to a column `expression`. What
Ossie does not describe is where a model then deploys. `kcmd` adds that deployment
layer and a few modeling constructs, and it relaxes a few of Ossie's required
fields so a model can stay purely logical.

Those additions come in **two versions**, and a document picks one with its
top-level `version` (see [Version handling](#1-status-and-baseline)):

- **`0.2.0.dev0`** — **vanilla Ossie**. `kcmd`'s additions ride in Ossie's own
  `custom_extensions` carrier ([§6](#6-the-extension-mechanism)); the native
  extension keys are not accepted. This profile is a strict superset of Ossie:
  strip the `GOOGLE` extension blocks and it is a plain Ossie document.
- **`0.2.0.dev0/google`** — the **extended profile**. The same additions are
  first-class native keys (`entities`, `deployment_target`, `extends`,
  `abstract`); the `custom_extensions` carrier is not accepted, because there is
  nothing left for it to carry. This profile is readable, but not a vanilla-Ossie
  document — an Ossie-only reader knows neither its version nor its native keys.

For a model that avoids the `/google`-only constructs, the two are the same model
written two ways; both parse to the identical IR, so no downstream leg sees which
was used.

Ossie compatibility is a property of the **vanilla** version, and the contract
runs in both directions:

> **Every Ossie `0.2.0.dev0` document is a valid `kcmd` model.** The reverse holds
> for a vanilla `kcmd` model that uses no extensions ([§5](#5-extensions)) *and* no
> relaxations ([§4](#4-narrowings-and-relaxations)) — a fully-bound model with only
> Ossie constructs. Strip the `GOOGLE` `custom_extensions` blocks from such a model
> and it is a valid Ossie document.

Under vanilla, `kcmd`'s deployment and binding additions ride in a `custom_extensions`
block an Ossie-only tool ignores (see [§6](#6-the-extension-mechanism)), so those never
fork the document; inheritance and the `entities` spelling have no vanilla form and
exist only under `0.2.0.dev0/google`. The extended `0.2.0.dev0/google` profile trades that wire
compatibility for readable native keys; it is `kcmd`'s own surface, converted to or
from vanilla by choosing the `version`.

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

**Version handling.** `version` is **required** and lives at the top of the
document (not inside a model). It MUST be one of two values: `0.2.0.dev0` (vanilla
Ossie) or `0.2.0.dev0/google` (the extended profile). A missing or unrecognized
`version` is a **hard load error**, not a warning — the value selects which
extension surface is legal ([§6](#6-the-extension-mechanism)), so it cannot be
guessed. `kcmd`'s own tools (pull, the OWL importer) emit `0.2.0.dev0/google`;
hand-authored portable models SHOULD use vanilla `0.2.0.dev0`.

**Baseline.** The Ossie classifications in [§3](#3-conformance-summary) are
reconciled against the Ossie `0.2.0.dev0` core JSON Schema, a copy of which is
vendored in this repository at
`tests/libts/semantic/fixtures/ossie/osi-schema.json` (copied unmodified from
`apache/ossie`). That schema, not `kcmd`'s parser, is the authority for what Ossie
defines; the parser is the authority only for what `kcmd` accepts.

## 2. Document shape

A model document is a YAML file with a top-level `semantic_model` list.

```yaml
version: "0.2.0.dev0"          # required; selects the extension surface (§1)
semantic_model:                # one or more models; kcmd deploys exactly one per entry group (§4)
  - name: sales
    datasets: [ … ]            # one or more; the entities (§2.1). Spelled `entities:` under /google (§5)
    relationships: [ … ]       # optional (§2.2)
    metrics: [ … ]             # optional (§2.3)
    description: "…"           # optional
    ai_context: { … }          # optional (§2.4)
    custom_extensions: [ … ]   # vanilla only (§6); rejected under /google
    deployment_target: "…"     # /google only (§5, §7); vanilla carries it in a GOOGLE block
```

A document MUST contain at least one model, and each model MUST contain at least
one dataset. Every named object (dataset, field, relationship, metric) MUST have a
name unique within its scope; a duplicate name is a **hard load error** (agreed
with Dmitri), because it would make the generated node, property, edge, or measure
ambiguous.

Objects are **closed**: an unknown sibling key inside a validated object is a
**hard error**, not silently dropped (agreed with Dmitri). This is what makes the
version gate bite — a native key under vanilla, or a `custom_extensions` block
under `/google`, is an unknown key for that version and is rejected
([§6](#6-the-extension-mechanism)). Setting both `entities` and `datasets` is
likewise an error ([§5](#5-extensions)).

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
| `expression` | [expression](#25-expressions) | physical-column binding; a field with none is *unbound* (binding — [§7](#7-the-binding-layer)) |
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

A field's `expression` is its binding; a field with no `expression` is **unbound**
(no column under this binding). There is no separate `unbound` flag — absence is
the signal. See [§7](#7-the-binding-layer).

#### 2.1.2. Inheritance (`extends`)

`extends` is a `kcmd` **extension** — Ossie `0.2.0.dev0` has no inheritance
construct ([§5](#5-extensions)). A dataset MAY declare `extends: [Parent, …]`,
naming one or more supertype datasets by name. Inheritance is **entity-level
only** — relationships do not `extends`. A supertype that has no table of its own
MUST be marked `abstract: true` (also an extension).

The format rule is only that supertypes are named datasets in the same model. An
`extends` that names a dataset not defined in the model is a **hard error** (a typo
must not silently drop inheritance — agreed with Dmitri). The resolver breaks
cycles with a warning and flattens diamonds (each ancestor contributes once,
nearest-first).
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

Every construct, at a glance, measured against **Ossie `0.2.0.dev0`** — the
vanilla baseline (see [§1](#1-status-and-baseline)). The **OSI** column is what
that baseline defines, where a `—` means Ossie does not define the construct at
all. The **Google extension** column is how this profile differs: *same* (adopted
unchanged), *optional* (a relaxation, [§4](#4-narrowings-and-relaxations)),
*stricter* (a narrowing, [§4](#4-narrowings-and-relaxations)), *added* (an
extension, [§5](#5-extensions)), or *rejected* / *not authorable* (excluded).
**Why / where** gives the reason and the section with the detail.

| Feature | OSI (`0.2.0.dev0`) | Google extension | Why / where |
|---|---|---|---|
| `semantic_model`, `name`, `description` | defined | same | [§2](#2-document-shape) |
| `datasets` | defined | same | [§2.1](#21-dataset-entity) |
| `entities` (alias for `datasets`) | — | added (alias) | readability; sugar, `/google` only · [§5](#5-extensions) |
| field `name`, `label`, `dimension` (`is_time`) | defined | same | [§2.1.1](#211-field) |
| `datatype` + vocabulary | closed enum | same (identical set) | [§2.1.1](#211-field) |
| `primary_key`, `unique_keys` | defined | same | [§2.1](#21-dataset-entity) |
| `extends` | — | added | class inheritance; `/google` only · [§2.1.2](#212-inheritance-extends), [§5](#5-extensions) |
| `abstract` | — | added | supertype with no table; `/google` only · [§5](#5-extensions) |
| relationship `name`, `from`, `to` | defined | same | [§2.2](#22-relationship) |
| relationship `from_columns` / `to_columns` | required | optional | model before binding; none = logical edge · [§4.2](#42-relaxations-looser-than-ossie) |
| relationship M:N (`association`) | — | not authorable (reserved) | no M:N syntax yet · [§2.2](#22-relationship) |
| `metrics`, metric `expression` | required | same; graph-bound stricter | a graph measure binds one node and aggregate · [§4.1](#41-narrowings-stricter-than-ossie) |
| `expression.dialects` | closed enum | any dialect string | tolerate imported / newer input · [§4.2](#42-relaxations-looser-than-ossie) |
| field `expression` (column binding) | required | optional | model before binding; unbound is pruned · [§4.2](#42-relaxations-looser-than-ossie), [§7](#7-the-binding-layer) |
| `source` (table binding) | required | optional | logical-only models; graph deploy still needs it · [§4.2](#42-relaxations-looser-than-ossie), [§7.1](#71-table-sources) |
| `ai_context` (`instructions`, `synonyms`, `examples`) | `examples` are strings | same; `examples` any shape | tolerate imports; non-strings dropped · [§2.4](#24-ai_context), [§4.2](#42-relaxations-looser-than-ossie) |
| `custom_extensions` (`vendor_name`, `data`) | the extension carrier | rejected | `/google` uses native keys; nothing to carry · [§6](#6-the-extension-mechanism) |
| `deployment_target` | — | added | OSI omits deployment; vanilla carries it in `custom_extensions` · [§5](#5-extensions), [§7.2](#72-deployment-target) |
| binding profiles | — | added | one model, many stores · [§7.3](#73-binding-profiles) |
| multiple models per document | a list (many) | exactly one | entry group = model's identity · [§4.1](#41-narrowings-stricter-than-ossie) |

## 4. Narrowings and relaxations

This profile diverges from Ossie in two directions. **Narrowings** are where it is
stricter — rules that can reject an otherwise-valid Ossie document at deploy time.
**Relaxations** are where it is looser — fields Ossie requires that this profile
makes optional, so a relaxed model is not a valid Ossie document until those
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

- **Unknown keys are rejected.** Every object is validated closed: an unrecognized
  sibling key is a hard load error, not silently dropped. Combined with the version
  gate, this is how a native key under vanilla — or a `custom_extensions` block
  under `/google` — is caught ([§6](#6-the-extension-mechanism)).

- **Duplicate names are rejected.** A dataset, field, relationship, or metric name
  repeated within its scope is a hard load error; the generated element would be
  ambiguous.

- **An unknown supertype is rejected.** An `extends` that names a dataset not in the
  model is a hard load error (see [§2.1.2](#212-inheritance-extends)).

- **A graph measure binds only to a leaf type.** For a BigQuery target, a metric
  whose entity is a supertype — one another entity `extends` — cannot become a
  `MEASURE` and is skipped with a warning: the supertype's label is shared across
  its subtype tables, and BigQuery forbids a `MEASURE` on a shared label. Like the
  single-aggregate rule this is a SHOULD, not a MUST — the metric still reaches
  Knowledge Catalog; it simply has no graph measure. See [Reference → Class
  hierarchies](reference.md#class-hierarchies-extends--labels).

Not a narrowing, contrary to a common assumption: **diamonds in a class hierarchy
are not rejected.** The resolver flattens them (each ancestor once) and breaks
cycles with a warning. What *is* rejected is downstream and store-specific — a
BigQuery `MEASURE` cannot bind to a label shared across subtype tables. See
[§2.1.2](#212-inheritance-extends).

### 4.2. Relaxations (looser than Ossie)

This profile relaxes Ossie in two kinds, for two different reasons.

**Binding fields made optional — to model before binding.** Ossie marks these
required; `kcmd` accepts them as optional so a model can be governed before it is
bound (a purely *logical* model). At graph deploy a non-abstract dataset must
still declare a `source` — the corresponding narrowing in
[§4.1](#41-narrowings-stricter-than-ossie). An omitted field `expression` or
relationship join column is not an error: the field is unbound and the
availability pass prunes it, and a relationship with no join columns is a
logical edge.

- **`source` on a dataset** — required in Ossie; optional in `kcmd`. A non-abstract
  dataset bound for a graph MUST still declare one.
- **`expression` on a field** — required in Ossie; optional in `kcmd`. A field
  with no `expression` is unbound and is pruned at graph generation; supply
  the column in a binding profile to bind it.
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

- **`entities` as an alias for `datasets` (extended profile only).** Under
  `0.2.0.dev0/google` a model MAY spell its datasets `entities:` instead of
  `datasets:`; setting both is an error. Pure sugar — identical meaning. Under
  vanilla Ossie the key is not accepted; use `datasets`. `kcmd`'s pull always emits
  `entities`.

- **`extends` on a dataset (extended profile only).** Class inheritance — a
  subtype names its supertype datasets. Ossie `0.2.0.dev0` has no inheritance
  construct, so it is accepted only under `0.2.0.dev0/google`. See
  [§2.1.2](#212-inheritance-extends).

- **`abstract: true` on a dataset (extended profile only).** Marks a concept with
  no physical table (typically an `extends` supertype). An abstract dataset produces
  no node table and MUST NOT declare a `source`. Accepted only under
  `0.2.0.dev0/google`.

- **`deployment_target` (extended profile only).** The physical destination — one
  graph in one store — as a first-class model-level (or profile-level) key, accepted
  under `0.2.0.dev0/google`. Under vanilla Ossie there is no native key; the same
  target is written as a `GOOGLE` `custom_extensions` block carrying
  `{"deploymentTargets": ["…"]}` ([§6](#6-the-extension-mechanism)). Grammar in
  [§7](#7-the-binding-layer).

- **Binding profiles.** A separate document that supplies only the physical
  bindings, so one logical model serves several stores. Not part of the Ossie
  document; a `kcmd`-specific file alongside it ([§7](#7-the-binding-layer)).

Deliberately **not** extensions in `0.2.0.dev0`, to avoid the impression they
exist: there is **no `actions` block** and **no authorable M:N `association`
syntax**. Both are reserved for future consideration; neither is part of the
format today.

## 6. The extension mechanism

The `version` selects **one** of two mutually exclusive extension surfaces (agreed
with Dmitri). A document uses the carrier *or* the native keys, never both — which
surface applies is a property of the version, not a per-key choice.

**Vanilla `0.2.0.dev0` — the `custom_extensions` carrier.** Under vanilla Ossie
every `kcmd` extension rides in Ossie's own `custom_extensions` field. An entry is:

```yaml
custom_extensions:
  - vendor_name: GOOGLE       # the namespace
    data: "{ … }"             # an opaque, vendor-serialized string (typically JSON)
```

`custom_extensions` MAY appear on the model, a dataset, a field, a relationship,
and a metric. `data` is opaque at the format level: nothing is interpreted when the
document is parsed, and it round-trips verbatim. An Ossie-only tool treats a
`GOOGLE` block as a vendor extension it does not recognize and passes it through
unchanged — so a vanilla `kcmd` model is still a valid Ossie document, and stripping
the `GOOGLE` blocks yields plain Ossie. A model's deployment target rides here as a
`GOOGLE` block carrying `{"deploymentTargets": ["…"]}`. The native keys (`entities`,
`deployment_target`, `extends`, `abstract`) are **not accepted** under vanilla —
each is an unknown key and rejected ([§4.1](#41-narrowings-stricter-than-ossie)).

**Extended `0.2.0.dev0/google` — native keys.** Under the extended profile the same
information is written as first-class keys — `entities`, `deployment_target`,
`extends`, `abstract` — read directly, with no `data` string to encode. There is
therefore nothing left for the carrier to carry, and a `custom_extensions` block is
**not accepted** under `/google` (also an unknown key). This is the profile `kcmd`'s
own tools emit: readable, but no longer a vanilla-Ossie document.

**Converting between the two** is the `version` plus a mechanical fold: a vanilla
`GOOGLE` deployment-target block becomes a native `deployment_target:` key under
`/google`, and back. Both parse to the identical IR. Constructs that exist only as
native keys (inheritance, the `entities` spelling) have no vanilla form and are
simply unavailable there. What survives a push and a pull through each surface is in
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
- **an unbound field** — a field with no column under a given binding, expressed
  by omitting its `expression` (there is no `unbound` flag).

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
exactly one ([§4](#4-narrowings-and-relaxations)). The identifier segments are
restricted to `[A-Za-z0-9_-]`. The native `deployment_target:` key shown here is the
extended-profile form; under vanilla Ossie the same target rides in a `GOOGLE`
`custom_extensions` block ([§6](#6-the-extension-mechanism)).

### 7.3. Binding profiles

A **binding profile** is a separate document that supplies only the physical
bindings for a model, so one logical model can deploy to several stores from one
definition. A profile:

- is a `semantic_model` document in the **same schema** as the logical model, but
  MUST set only physical-binding keys: at the model level `deployment_target` and
  `datasets`/`entities`; at the dataset level `source` and `fields`; at the field
  level `expression`. Setting any logical key (a new field, `primary_key`, a
  relationship, …) in a profile is an error — the logical model owns those.
- binds by `name` at each level. A field a profile does not bind is left **unbound**
  for that profile (selecting a profile clears the logical model's inline column
  bindings, so the profile alone decides what is bound); there is no `unbound` flag.
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

- **What declaring a version guarantees.** The constructs in
  [§2](#2-document-shape) and the extensions in [§5](#5-extensions) are what `kcmd`
  reads and writes. The `version` is a **gate**, not advice: it is required, must be
  `0.2.0.dev0` or `0.2.0.dev0/google`, and selects the legal extension surface
  ([§6](#6-the-extension-mechanism)); any other value is a hard error.

- **When Ossie changes.** A new Ossie construct is added to
  [§3](#3-conformance-summary) as a row — *as-is* if adopted unchanged, *narrowed*
  if constrained. Growth is a table entry, not a rewrite; this document's size
  tracks `kcmd`'s decisions, not Ossie's surface.

- **Forward direction of each extension.** A native `/google` key is either a
  candidate to upstream into Ossie (e.g. `deployment_target`, `entities`) or a
  Google-store specific that stays `kcmd`'s own. The vanilla version stays a strict
  Ossie superset: its only extension is the `GOOGLE` `custom_extensions` carrier,
  and constructs with no vanilla form (inheritance, the `entities` spelling) are
  simply unavailable there — a model that needs them uses `0.2.0.dev0/google`.

- **Reserved constructs.** `association` (M:N) and any `actions`-like write-side
  construct are reserved: recognized as future work, not authorable today. A
  document MUST NOT rely on either in `0.2.0.dev0`.

## Appendix: annotated example

A logical model plus one binding profile.

```yaml
# catalog/EntryGroups/sales/sales.yaml — the logical model (concepts + edge join keys;
# table and column bindings live in the profile below — see §7)
version: "0.2.0.dev0"          # vanilla Ossie: uses no native keys, so this file is portable
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
version: "0.2.0.dev0/google"   # native deployment_target key -> extended profile
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
