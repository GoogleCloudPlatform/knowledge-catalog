# Importing SHACL shapes as constraints

`kcmd shacl import` reads a [SHACL](https://www.w3.org/TR/shacl/) shapes graph
and adds the rules it states to an **existing** semantic model as native
model-level [constraints](actions.md#2-gate-it-with-a-constraint). The model is
typically one `kcmd owl import` wrote (see [Importing an OWL
ontology](owl-import.md)); it can equally be hand-written.

Each constraint then behaves like any other: Knowledge Catalog publishes it as a
governed entry that an agent reads, and an action that lists it in `guards` is
refused when its write would break it. Nothing is carried opaquely: a SHACL term
either becomes (part of) a constraint or is **warned and skipped**.

```console
$ kcmd owl import ontology/*.ttl --name deals --out deals.yaml
$ kcmd shacl import shapes/deals.shapes.ttl --into deals.yaml
read 5 shapes; 8 constraints for model 'deals'
wrote deals.yaml
coverage (shacl import of model 'deals'):
  ...
wrote coverage.json
```

| Flag | Meaning |
|---|---|
| `--into <model.yaml>` | The model document to add the constraints to. Without it, the model named by `--model` is read from, and written back to, the scope's semantic-model layout. |
| `--model <name>` | The model receiving the constraints. Required without `--into`; with `--into` it confirms the document's model (a document declares one model, and the load refuses a document that declares two). |
| `--out <path>` | Write the updated document here instead of back to its source. |
| `--coverage <path>` | Proposed. Write the [coverage report](#3-coverage-report-proposed) here instead of to `coverage.json` beside the written document. |
| `--no-coverage` | Proposed. Print no coverage summary and write no coverage report. |

Several shapes files are read as one shapes graph. The document is **edited in
place**: comments, layout, keys, and every other constraint are left as they
were.

## 1. What a shape becomes

A **node shape** (`sh:NodeShape`, or any subject with `sh:targetClass` /
`sh:property`) selects its entity through `sh:targetClass`, or — when the shape
is also an `owl:Class` / `rdfs:Class` — targets itself (SHACL's implicit class
target). Each of its **property shapes** is resolved against that entity: the
`sh:path` must be a single property IRI naming a **relationship** that starts at
the entity or one of its supertypes, or a **field** of the entity or one of its
supertypes (see [Modeling class hierarchies](inheritance.md)). A standalone
`sh:PropertyShape` with its own `sh:targetClass` is read the same way.

```turtle
shp:OpportunityShape a sh:NodeShape ;
    sh:targetClass ex:Opportunity ;
    sh:property [
        sh:path ex:hasBuyer ;
        sh:minCount 1 ; sh:maxCount 1 ;
        sh:message "Every opportunity needs exactly one buyer account."
    ] ;
    sh:property [
        sh:path ex:stage ;
        sh:in ( "Qualify" "Propose" "Won" "Lost" ) ;
        sh:severity sh:Info
    ] .
```

```yaml
    constraints:
      - name: Opportunity_hasBuyer_exactly_1
        judgment: Each Opportunity has exactly one hasBuyer relationship to a
          ClientAccount. An Opportunity with no hasBuyer relationship to a
          ClientAccount, or with more than one, does not satisfy this rule.
        description: "Every opportunity needs exactly one buyer account. (From SHACL:
          OpportunityShape, hasBuyer sh:minCount 1 sh:maxCount 1.)"
        on_violation: reject
        severity: high
      - name: Opportunity_stage_in
        judgment: Every Opportunity.stage that is set is one of 'Qualify', 'Propose',
          'Won' or 'Lost'. An Opportunity with any other Opportunity.stage does
          not satisfy this rule.
        description: "Set Opportunity.stage to one of 'Qualify', 'Propose', 'Won' or
          'Lost'. (From SHACL: OpportunityShape, stage sh:in (Qualify Propose
          Won Lost).)"
        on_violation: warn
        severity: low
```

### Mapping

`C` is the target entity; `p` the relationship and `f` the field the `sh:path`
names.

| SHACL (on a property shape) | Constraint | Notes |
|---|---|---|
| `sh:minCount n` = `sh:maxCount n` on a relationship | `C_p_exactly_n` | `n = 0`: no such edge |
| `sh:minCount n` (n > 0) on a relationship | `C_p_min_n` | |
| `sh:maxCount n` on a relationship | `C_p_max_n` | |
| `sh:class X` on a relationship | `C_p_only_X` | no rule when `X` is `p`'s destination (an edge always ends there) |
| `sh:qualifiedValueShape [ sh:class X ]` + `sh:qualifiedMinCount` / `sh:qualifiedMaxCount` | `C_p_exactly_n_X` / `C_p_min_n_X` / `C_p_max_n_X` | no `_X` suffix when `X` is `p`'s destination; the qualifying shape must be exactly one `sh:class` |
| `sh:minCount 1` on a field | `C_f_required` | a minimum above one cannot be met by a single-valued field: warned |
| `sh:maxCount 0` on a field | `C_f_empty` | `sh:maxCount` ≥ 1 on a field is structural (a field holds one value): dropped |
| `sh:pattern` (+ `sh:flags`) | `C_f_pattern` | |
| `sh:in ( ... )` | `C_f_in`, or `C_f_value_v` for a single value | an IRI member is written as its local name |
| `sh:minInclusive` / `sh:minExclusive` / `sh:maxInclusive` / `sh:maxExclusive` | `C_f_range` | all bounds of one property shape in one rule |
| `sh:minLength` / `sh:maxLength` | `C_f_length` | |
| `sh:datatype` | — | agrees with the field's `datatype`: dropped; conflicts: warned (the model's datatype stands) |
| `sh:lessThan g` on a field | `C_f_lt_g` | `g` must be a field of `C` or a supertype (see below) |
| `sh:lessThanOrEquals g` on a field | `C_f_lte_g` | as above |
| `sh:equals g` on a field | `C_f_eq_g` | as above |
| `sh:disjoint g` on a field | `C_f_disjoint_g` | as above |

### Property pairs

SHACL's property-pair terms compare the field the `sh:path` names with
**another field of the same entity** — a rule between two columns of one row:

```turtle
shp:DealPricingShape a sh:NodeShape ;
    sh:targetClass ex:DealPricing ;
    sh:property [
        sh:path ex:floorPrice ;
        sh:lessThanOrEquals ex:targetPrice ;
        sh:severity sh:Warning
    ] .
```

```yaml
      - name: DealPricing_floorPrice_lte_targetPrice
        judgment: Each DealPricing's floorPrice must be less than or equal to its
          targetPrice. A DealPricing whose DealPricing.floorPrice is greater
          than its DealPricing.targetPrice does not satisfy this rule. The rule
          compares the two only when both are set.
        description: "Keep DealPricing.floorPrice at most DealPricing.targetPrice. (From
          SHACL: DealPricingShape, floorPrice sh:lessThanOrEquals targetPrice.)"
        on_violation: warn
        severity: medium
```

A field holds one value, so each term reads at row level: `sh:lessThan` /
`sh:lessThanOrEquals` compare the two values when both are set; `sh:equals`
requires the same value, or both unset; `sh:disjoint` forbids the same value.
Each value of a term is its own rule (`sh:lessThan ex:a, ex:b` gives two).
The judgment names both columns as `Entity.field`, so push validation checks
them like any other rule's.

Warned and skipped: an other path that is not a field of `C` or one of its
supertypes (a relationship, another entity's field, an unknown name, or a
non-IRI value); a field compared with itself; and an ordering or `sh:equals`
between datatypes whose values never compare (a `Decimal` with a `String`;
`Integer`, `Decimal` and `Float` compare with each other). `sh:disjoint`
between such datatypes always holds, so it is dropped silently. A pair on a
relationship path is warned: an edge has no single value to compare.

### Severity, message, and names

SHACL's own `sh:severity` sets both enforcement facets. It is read per shape, as
the SHACL spec defines it — a property shape does not inherit its node shape's
severity — and a shape with none is `sh:Violation`, the SHACL default:

| `sh:severity` | `severity` | `on_violation` |
|---|---|---|
| `sh:Violation` (or none) | `high` | `reject` |
| `sh:Warning` | `medium` | `warn` |
| `sh:Info` | `low` | `warn` |

Any other severity IRI is warned and treated as `sh:Violation`.

The `description` — the text a violation surfaces — is the shape's `sh:message`
(an untagged or English one when there are several), else its `sh:description`,
else a generated steering sentence ("Set Opportunity.opportunityId on every
Opportunity."). It always ends with a provenance note, `(From SHACL: <shape>,
<path> <terms>.)`. The `judgment` is always generated from the terms, so it
states exactly the rule the shape checks.

Names are deterministic — `<Entity>_<path>_<rule>`, plus `_<other>` for a
property pair — and sanitized to letters,
digits, and `_`. A name already taken by another constraint gets a `_2`, `_3`,
… suffix.

## 2. Re-importing

The import is **idempotent**. Before adding, it removes the constraints it
generated earlier from any shape in the **current** input (recognized by the
provenance note), then adds the current ones. So:

- re-running the same import leaves the document unchanged;
- editing a shape and re-importing updates that shape's constraints;
- deactivating a shape (`sh:deactivated true`) and re-importing removes them;
- constraints from shapes **not** in the current input, and hand-written
  constraints, are kept. To drop a shape's constraints entirely, delete them
  from the model, or re-import the shape deactivated.

A blank-node node shape has no stable name, so its provenance key is the
classes it targets (`[anonymous shape for Opportunity]`); give shapes IRIs to
keep their constraints apart.

## 3. Coverage report (proposed)

The warnings explain single gaps. The coverage report shows the whole import:
every import prints a summary per construct and writes the full report to
`coverage.json` beside the document it wrote. `--coverage <path>` writes the
report elsewhere; `--no-coverage` skips both the summary and the file. The
report lists **every** shape and constraint component the import read, each
with one outcome:

| Outcome | For a shape or constraint component |
|---|---|
| `compiled` | A constraint states it: the constraint's provenance note quotes the term. Or the model already guarantees it, so no constraint is needed: `sh:maxCount` of one or more on a field, `sh:class` equal to the relationship's destination, `sh:minCount 0`, an `sh:datatype` that agrees with the field. |
| `hinted` | Not used by this import: a SHACL rule either becomes a constraint or is not carried. The [OWL import](owl-import.md#6-coverage-report-proposed) uses it. |
| `dropped` | Not carried. The reason is the import's own warning when it raised one, else a short statement such as `not supported` or `its property shape was not carried`. |

The [mapping table](#mapping) calls a term that needs no constraint
*dropped* (an `sh:maxCount` on a field, an agreeing `sh:datatype`): no
constraint is written for it. The report counts it as compiled, with the
target `model structure`, because the model already holds the rule.

Take a model whose `Order` has the fields `orderId`, `status` and `total` and
the relationship `placedBy` (but no `discount`), and these shapes:

```turtle
shp:OrderShape a sh:NodeShape ;
    sh:targetClass ex:Order ;
    sh:property [ sh:path ex:placedBy ; sh:minCount 1 ; sh:maxCount 1 ;
                  sh:message "Every order has exactly one customer." ] ;
    sh:property [ sh:path ex:orderId ; sh:minCount 1 ; sh:datatype xsd:string ;
                  sh:pattern "^O-[0-9]+$" ; sh:name "order id" ] ;
    sh:property [ sh:path ex:status ; sh:in ( "open" "shipped" ) ;
                  sh:severity sh:Warning ] ;
    sh:property [ sh:path ex:total ; sh:minInclusive 0 ;
                  sh:node shp:MoneyShape ] ;
    sh:property [ sh:path ex:discount ; sh:maxCount 1 ] .

shp:VipShape a sh:NodeShape ;
    sh:targetNode ex:alice ;
    sh:property [ sh:path ex:customerId ; sh:minCount 1 ] .

shp:RetiredShape a sh:NodeShape ;
    sh:targetClass ex:Customer ;
    sh:deactivated true ;
    sh:property [ sh:path ex:customerId ; sh:minCount 1 ] .
```

After its three warnings (`sh:node` on a field, the unknown `discount`, the
`sh:targetNode`), the import prints:

```console
read 3 shapes; 5 constraints for model 'shop'
wrote shop.yaml
coverage (shacl import of model 'shop'):
  construct         compiled  hinted  dropped
  sh:NodeShape             1       0        2
  sh:PropertyShape         4       0        3
  sh:minCount              2       0        0
  sh:maxCount              1       0        1
  sh:message               1       0        0
  sh:datatype              1       0        0
  sh:pattern               1       0        0
  sh:name                  0       0        1
  sh:in                    1       0        0
  sh:severity              1       0        0
  sh:minInclusive          1       0        0
  sh:node                  0       0        1
  sh:targetNode            0       0        1
  total                   14       0        9
wrote coverage.json
```

Each counted occurrence is one entry in the report. Four of them:

```json
[
  {"construct": "sh:pattern", "subject": "OrderShape / orderId on Order",
   "outcome": "compiled", "target": "constraint Order_orderId_pattern"},
  {"construct": "sh:datatype", "subject": "OrderShape / orderId on Order",
   "outcome": "compiled", "target": "model structure",
   "reason": "already guaranteed by the model structure; no constraint needed"},
  {"construct": "sh:name", "subject": "OrderShape / orderId on Order",
   "outcome": "dropped",
   "reason": "a property shape display name has no slot in the model"},
  {"construct": "sh:NodeShape", "subject": "RetiredShape",
   "outcome": "dropped", "reason": "sh:deactivated true"}
]
```

How each occurrence gets its outcome:

- **A node shape** is compiled when at least one of its property shapes is
  carried, and dropped otherwise. A node shape with no `sh:targetClass` (and
  not itself a class), or with `sh:deactivated true`, is dropped. Each of its
  property shapes is then listed as dropped after it, without its terms.
- **A property shape** is listed once per target class
  (`OrderShape / total on Order`). It is dropped, with each of its terms, when
  the import skips it as a whole: the target is not an entity, the path names
  no field or relationship of it, or the shape is deactivated. It is also
  dropped when none of its terms is carried. Otherwise it is compiled, and the
  reason counts the terms that were dropped.
- **`sh:message`** (else `sh:description`) and **`sh:severity`** ride on the
  constraints their property shape produced. When the shape produced none,
  because the model already guarantees each of its rules, they are dropped with
  `no constraint was derived to carry it`.
- **`sh:name`** is always dropped: a constraint has no slot for a display name.
- Targets other than `sh:targetClass`, node-level terms (`sh:closed`, `sh:or`,
  ...) and unsupported property terms are dropped. The presentational terms
  `sh:order`, `sh:group` and `sh:defaultValue` are not listed.

> [!NOTE]
> "Guaranteed by the model structure" is a statement about the model, not
> about the stored rows. An `Order` row whose customer key matches no
> `Customer` still breaks `sh:class Customer` on `placedBy`; the structural
> `references` check of `kcmd validate` counts such rows. Nothing checks the
> stored values against an `sh:datatype` that agrees with the field.

`coverage.json` is shared with `kcmd owl import`; its format is described in
[What an import keeps](fidelity.md#what-an-import-keeps-proposed). A SHACL
import replaces only the `shacl` report of its model, so importing an ontology
and then its shapes leaves one file holding both reports.

## Limitations

Warned and skipped (never carried):

- **Paths** other than a single property IRI: inverse (`sh:inversePath`),
  sequence, alternative, and zero-or-more paths.
- **Targets** other than classes: `sh:targetNode`, `sh:targetSubjectsOf`,
  `sh:targetObjectsOf` — the model holds entities, not individual nodes.
- **Nested and logical shapes**: `sh:node`, `sh:or` / `sh:and` / `sh:not` /
  `sh:xone`, `sh:closed`, node-level `sh:class`, and a qualified value shape
  that is anything but one `sh:class`.
- **Value terms on a relationship** (`sh:datatype`, `sh:pattern`, `sh:in`,
  ranges, lengths, property pairs) and **node terms on a field** (`sh:class`,
  `sh:node`, qualified shapes).
- **Property pairs** whose other path is not a field of the target entity or
  one of its supertypes, that compare a field with itself, or that order or
  equate values of incomparable datatypes (see [Property
  pairs](#property-pairs)).
- Any other SHACL term on a property shape (e.g. `sh:uniqueLang`,
  `sh:hasValue`, `sh:languageIn`, SPARQL-based constraints).

Dropped without a warning: presentational terms (`sh:order`, `sh:group`,
`sh:defaultValue`), `sh:name` (a display label with no slot on a constraint),
and deactivated shapes. The [coverage report](#3-coverage-report-proposed)
still lists `sh:name` and each deactivated shape as dropped; it does not list
the presentational terms.

The constraints are **judged** rules, like every model constraint: an agent or
an action guard reads the judgment, and nothing at write or query time filters
on the bound data. To measure the stored data against the imported rules, run
`kcmd validate --target bigquery`, which compiles each rule (from its
provenance note) to a violation-count query -- see
[Validating constraints against BigQuery](validation.md).
