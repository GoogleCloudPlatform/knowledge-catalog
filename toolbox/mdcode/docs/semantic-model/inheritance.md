# Modeling class hierarchies

When several entities are kinds of one thing — a customer and a supplier are both
parties you deal with — you can declare the general kind once and say that each
specific kind `extends` it. A query written against the general kind then reaches
every specific kind. `extends` is the semantic model's *is-a*: a customer is a
party.

`kcmd push` expresses the hierarchy on the graph as **labels**. A subtype's node
table carries its own label plus one label per supertype, so `MATCH (:Party)`
matches every customer and every supplier. The exact generation rules — how
fields flatten down, what a label signature must contain — are in
[Reference → Class hierarchies](reference.md#class-hierarchies-extends--labels);
this page is the modeling guide.

## When to use it

Use `extends` when the shared fields reflect a real *is a kind of* relationship
and you want a supertype query to gather every subtype.

Do not use it when the shared fields are a coincidence of naming, or when you
have one entity whose columns happen to be split across two tables — that is a
[binding](profiles.md), and modeling it as inheritance produces the double-count
described below.

## The one rule

A supertype query gathers every subtype. Because it gathers subtypes, **each real
thing must live in exactly one place**, or it is gathered more than once and your
counts double. State it once and rely on it:

> **One real thing, one row, one node.**

Everything below is a way to honor this rule.

## 1. Declare the hierarchy

`Party` is the general kind. In this model no row is *just* a party — every party
is a customer or a supplier — so `Party` has no table of its own. Mark it
`abstract: true`: it has no `source` and no key, produces no node table, and
survives in the graph only as a label on its subtypes.

Each concrete kind declares its own fields and the one `extends` keyword. The
supertype's fields are inherited, so you do not repeat them:

```yaml
version: "0.2.0.dev0/google"
semantic_model:
  - name: parties
    entities:
      - name: Party
        abstract: true
        primary_key: [id]
        fields:
          - { name: id,   datatype: Integer }
          - { name: name, datatype: String }
      - name: Customer
        extends: [Party]
        primary_key: [id]          # each subtype keeps its OWN key; keys are not inherited
        fields:
          - { name: loyalty_tier, datatype: String }
      - name: Supplier
        extends: [Party]
        primary_key: [id]
        fields:
          - { name: rating, datatype: Integer }
```

The supertype's `id` and `name` flatten down onto both subtypes, so `Customer`
and `Supplier` each expose them, and each subtype node carries both its own label
and the `Party` label.

```mermaid
classDiagram
    class Party {
        <<abstract>>
        id : integer
        name : string
    }
    class Customer {
        loyalty_tier : string
    }
    class Supplier {
        rating : integer
    }
    Party <|-- Customer
    Party <|-- Supplier
```

`Party` is abstract, so it has no table of its own; the arrows are `extends`. A
query against `Party` reaches every subtype below it.

## 2. Bind each subtype's table

Inheritance meets binding at one requirement: **each subtype's table must expose
the inherited columns**, because those fields are read from the subtype's own
table. `Party.name`, flattened onto `Customer`, is read from the customer table,
so that table must have a name column.

A binding gives each entity its `source` and each field its column. With one
store you can bind inline on the model as the `default` profile:

```yaml
      - name: Customer
        extends: [Party]
        primary_key: [id]
        source: my-project.sales.customer
        fields:
          - { name: id,           datatype: Integer, expression: c_custkey }
          - { name: name,         datatype: String,  expression: c_name }   # the inherited field, bound here
          - { name: loyalty_tier, datatype: String,  expression: c_tier }
```

To bind the same hierarchy to more than one store, put each binding in its own
[profile](profiles.md). A profile answers the supertype query only for the
subtypes it binds: bind `Customer` but leave `Supplier` unbound and
`MATCH (:Party)` returns customers alone.

## 3. Query the supertype

```
GRAPH my-project.sales.parties
MATCH (p:Party)
RETURN p.name
```

Every customer and every supplier comes back, each once, because each real party
lives in exactly one table.

## More hierarchy shapes

`extends` composes. A subtype can extend several supertypes, and a supertype can
extend another supertype above it. Two facts hold for every shape: the supertype
fields flatten down, and each concrete table binds every inherited field to its
own column. So the shapes below all deploy the same way, and each was verified to
deploy on BigQuery Graph.

### Extending more than one supertype, and diamonds

`extends` takes a list. Here an `Employee` is both a `Person` and a `Taxpayer`,
and each of those is a `Party`:

```yaml
      - name: Party
        abstract: true
        primary_key: [id]
        fields:
          - { name: id,   datatype: Integer }
          - { name: name, datatype: String }
      - name: Person
        abstract: true
        extends: [Party]
        fields:
          - { name: birth_year, datatype: Integer }
      - name: Taxpayer
        abstract: true
        extends: [Party]
        fields:
          - { name: tax_id, datatype: String }
      - name: Employee
        extends: [Person, Taxpayer]
        primary_key: [id]
        source: my-project.hr.employee
        fields:
          - { name: id,         datatype: Integer, expression: e_id }
          - { name: name,       datatype: String,  expression: e_name }
          - { name: birth_year, datatype: Integer, expression: e_birth }
          - { name: tax_id,     datatype: String,  expression: e_tax }
          - { name: department, datatype: String,  expression: e_dept }
```

```mermaid
classDiagram
    class Party {
        <<abstract>>
        id : integer
        name : string
    }
    class Person {
        <<abstract>>
        birth_year : integer
    }
    class Taxpayer {
        <<abstract>>
        tax_id : string
    }
    class Employee {
        department : string
    }
    Party <|-- Person
    Party <|-- Taxpayer
    Person <|-- Employee
    Taxpayer <|-- Employee
```

`Party` sits at the top and is reached through two paths, so this is a diamond.
`Employee` carries the `Person`, `Taxpayer`, and `Party` labels, and `Party`
appears once. `MATCH (:Person)`, `MATCH (:Taxpayer)`, and `MATCH (:Party)` each
return every employee a single time. The number of supertypes a subtype has, and
the number of paths that reach a shared ancestor, do not change the count.

### Deeper hierarchies

A hierarchy can run several levels deep with a concrete table at each leaf. Here
`Party` divides into `Person` and `Organization`, and each has its own concrete
kind: a `Customer` is a person, a `Vendor` is an organization:

```yaml
      - name: Party
        abstract: true
        primary_key: [id]
        fields:
          - { name: id,   datatype: Integer }
          - { name: name, datatype: String }
      - name: Person
        abstract: true
        extends: [Party]
        fields:
          - { name: birth_year, datatype: Integer }
      - name: Organization
        abstract: true
        extends: [Party]
        fields:
          - { name: founded_year, datatype: Integer }
      - name: Customer
        extends: [Person]
        primary_key: [id]
        source: my-project.sales.customer
        fields:
          - { name: id,         datatype: Integer, expression: c_id }
          - { name: name,       datatype: String,  expression: c_name }
          - { name: birth_year, datatype: Integer, expression: c_birth }
          - { name: tier,       datatype: String,  expression: c_tier }
      - name: Vendor
        extends: [Organization]
        primary_key: [id]
        source: my-project.sales.vendor
        fields:
          - { name: id,           datatype: Integer, expression: v_id }
          - { name: name,         datatype: String,  expression: v_name }
          - { name: founded_year, datatype: Integer, expression: v_founded }
          - { name: rating,       datatype: Integer, expression: v_rating }
```

```mermaid
classDiagram
    class Party {
        <<abstract>>
        id : integer
        name : string
    }
    class Person {
        <<abstract>>
        birth_year : integer
    }
    class Organization {
        <<abstract>>
        founded_year : integer
    }
    class Customer {
        tier : string
    }
    class Vendor {
        rating : integer
    }
    Party <|-- Person
    Party <|-- Organization
    Person <|-- Customer
    Organization <|-- Vendor
```

`Customer` and `Vendor` are the only tables. `MATCH (:Party)` returns every
customer and every vendor; `MATCH (:Person)` returns customers alone, and
`MATCH (:Organization)` vendors alone. Each real party lives in one table, so
every count is exact.

### What keeps every shape correct

These shapes deploy because their supertypes are abstract. Each concrete table
binds every inherited field to its own column, and BigQuery matches a shared
label by property name, so the subtype tables never have to agree on a physical
column. A supertype with its own table works too. Then every subtype table must
carry that supertype's columns under the same names, and a thing present in both
the supertype table and a subtype table is counted twice under the supertype
label. Keeping supertypes abstract keeps the one rule — one real thing, one node
— automatic.

## Match the shape to how your data is stored

How your subtypes are already stored decides how you model them. `extends` builds
one shape directly, and the other two common layouts are modeled without it:

- **One table per kind, the parent has none.** Each concrete kind has its own
  complete table; the supertype has no table and survives as a label; a supertype
  query is the union of the kind tables. This is the shape `extends` builds — the
  hierarchy above. It is correct as long as the kind tables hold disjoint things,
  which is why the parent is `abstract`.
- **One table for the whole family, with a kind column.** All parties in one
  table, a `type` column saying which kind each row is. Model this as one entity
  with a dimension field; it holds one row per thing, so it cannot double-count.
- **A base table plus an extension table.** A thing's general fields in one table
  and its specific fields in another, tied by a shared key. Model this as one
  entity whose binding joins the two tables, so the thing keeps one identity.

## When a supertype total looks too high

If a supertype count or sum comes back larger than the data warrants, the same
real thing lives in more than one table under the hierarchy. Every table carrying
the label contributes that thing as its own node. Take three people split across
a `person` table and a `customer` table that both carry the `Person` label, with
two of the three present in both. `MATCH (:Person)` returns **five** nodes,
because no identity link across the two tables tells the graph that the shared
rows are the same person.

The fix is the one rule. Make the parent `abstract` so no real thing lives in more
than one table under the hierarchy. When the two tables are instead the general
and specific halves of one thing, model them as one entity whose binding joins
them by key.

## The rules push enforces

Fields flow down to subtypes; relationships and keys do not. A subtype's table
must expose every inherited column, or the deploy fails. A metric cannot sit on a
shared supertype; attach it to a concrete subtype. An inherited field cannot be
redefined with a different meaning, and every table under a shared supertype must
expose the identical field set. Each rule and the error it raises is in
[Reference → Class hierarchies](reference.md#class-hierarchies-extends--labels).

Inheritance deploys the same way to BigQuery Graph and Spanner Graph — the extra
labels and the flattened fields are identical on both backends. On Spanner the
model carries no measures, as it does for any model.

## Defined entities: a subtype picked out by a condition

Some subtypes are not stored anywhere on their own. A won opportunity is a row of
the opportunity table whose stage is `5_won`; in OWL it is a *defined class*,
`WonOpportunity ≡ Opportunity ⊓ (salesStage = '5_won')`. Declare it as a
**defined entity**: one parent, a membership condition, and nothing else.

```yaml
version: "0.2.0.dev0/google"
semantic_model:
  - name: sales
    entities:
      - name: Opportunity
        source: proj.sales.opportunity
        primary_key: [id]
        fields:
          - name: id
            expression: {dialects: [{dialect: ANSI_SQL, expression: id}]}
          - name: salesStage
            expression: {dialects: [{dialect: ANSI_SQL, expression: sales_stage}]}
          - name: totalContractValue
            expression: {dialects: [{dialect: ANSI_SQL, expression: tcv}]}
      - name: WonOpportunity
        description: An opportunity in the Won stage.
        extends: [Opportunity]
        defined: "salesStage = '5_won'"
      - name: HighValueOpportunity
        extends: [Opportunity]
        defined:
          expression: totalContractValue >= 1000
          description: USD thousands, so at least USD 1M.   # optional note
      - name: MegaDeal
        extends: [HighValueOpportunity]   # a defined entity may refine another
        defined: totalContractValue >= 20000
```

`defined` is a `/google` extension. It takes a bare string or `{expression,
description?}`. The expression is a boolean SQL expression (BigQuery dialect)
over the **field names** of the entity's lineage, not over columns. It may
qualify a name with the entity itself or an ancestor (`MegaDeal.totalContractValue`).
It reads one row, so it cannot reach another entity. A defined entity:

- **extends exactly one parent.** The parent may itself be defined. The nearest
  non-defined ancestor is its **base**, the entity whose rows it selects.
  Membership is the conjunction of every definition up to the base: MegaDeal is
  `(totalContractValue >= 1000) AND (totalContractValue >= 20000)` over
  Opportunity.
- **has no `source`, `primary_key`, `unique_keys` or fields of its own.** It
  shares its base's rows, identity and fields. The loader rejects a source or
  key. `abstract: true` is redundant and is ignored with a warning.
- **cannot be a supertype.** A table-backed entity may not extend a defined one.
  Extend its base instead.

**On a graph push** (BigQuery and Spanner) a defined entity forms no node table
and no label. It becomes a boolean property `is<Name>` on its base, computed
from the base's own bindings and made two-valued:

```sql
COALESCE(sales_stage = '5_won', FALSE) AS isWonOpportunity
```

So `MATCH (o:Opportunity) WHERE o.isWonOpportunity` answers "won
opportunities". The property's description states the condition. On an
abstract base each concrete descendant binds the property from its own columns.
A descendant that does not bind a referenced field gets `CAST(NULL AS BOOL)`,
with a warning. A relationship endpoint on a defined entity is re-pointed at its
base, and a metric attached to one is dropped (a MEASURE cannot filter rows),
both with a warning.

**Push validation** rejects:

- a missing, multiple or unknown parent, or a parent cycle;
- a source, keys or fields on a defined entity;
- a reference to a field the base does not have (with a hint for a case
  mismatch), or to another entity;
- a table-backed entity that extends a defined one;
- an `is<Name>` that collides with a field of the base or its descendants, or
  with another defined entity's property.

**Knowledge Catalog** publishes a defined entity as a semantic-entity entry like
an abstract one: no source resources and no key. Its definition rides the entry
description as fixed trailing paragraphs (`Definition note: …` when there is a
note, then `Defined as: <expression>`), after `Specializes: <parent>.`. Pull
peels them back off, so push → pull → push is a fixed point. A binding profile
that makes the base unavailable drops its defined entities too.

OWL import compiles `owl:equivalentClass` definitions into defined entities; see
[OWL import → Defined classes](owl-import.md#defined-classes-owlequivalentclass).

## Relationship inheritance

Relationships have a hierarchy of their own, separate from the entity one. A
general relationship names what several specific edges have in common, so one
query reaches all of them. `hasCounterparty` links a commercial document to the
organization on its other side; on an opportunity that organization is the
buyer, and on an invoice it is the payer:

```yaml
relationships:
  - name: hasCounterparty
    from: CommercialDocument
    to: Organization
    abstract: true              # a label over its sub-relationships, not an edge
  - name: hasBuyer
    from: Opportunity
    to: Client
    extends: [hasCounterparty]
    from_columns: [buyer_id]
    to_columns: [org_id]
  - name: hasPayer
    from: Invoice
    to: Organization
    extends: [hasCounterparty]
    from_columns: [payer_id]
    to_columns: [org_id]
```

Both keys are `/google` extensions (`version: …/google`):

- **`extends: [RelName, …]`** — the parents this relationship specializes. On a
  graph push each concrete edge table keeps its own `DEFAULT LABEL` (and
  description) and also carries `LABEL <parent> NO PROPERTIES` for every
  ancestor, nearest first. `MATCH (d)-[:hasCounterparty]->(o)` then spans the
  `hasBuyer` and `hasPayer` edge tables. The labels carry no properties, so
  edge tables over different sources never have to agree on columns.
- **`abstract: true`** — the relationship is only a label. It keeps `from`/`to`,
  which document what it connects, but takes no `from_columns`/`to_columns` and
  deploys no edge table. An abstract relationship nothing extends is warned
  (it would reach no edges).

The same one rule applies as for entities. A sub-relationship's `from` and `to`
should be its parent's ends or subtypes of them; the loader warns otherwise.
Keep the parent abstract. A *concrete* parent works too — it deploys as an edge
table whose `DEFAULT LABEL` carries `NO PROPERTIES`, with its description
dropped with a warning — but an edge present both in its table and in a child's
table then counts twice under the parent label.

Knowledge Catalog publishes each concrete relationship as usual and appends a
`Specializes: hasCounterparty.` line to its join description; an abstract
relationship publishes no link. See [Reference → Relationship
hierarchies](reference.md#relationship-hierarchies) for every rule, and [OWL
import](owl-import.md#property-hierarchies-rdfssubpropertyof) for how
`rdfs:subPropertyOf` maps onto it.
