# Importing an OWL ontology

An OWL ontology and a semantic model share a backbone: **classes ≈ entities**,
**object properties ≈ relationships**, **datatype properties ≈ fields**. `kcmd`
does not learn a second format — it **converts OWL into a semantic model** once,
then the ontology rides the normal [`kcmd push` / `kcmd pull`](README.md)
workflow. The semantic model stays the single canonical form.

The converter maps the OWL constructs that have a clean BigQuery Graph shape to
**native** semantic-model fields — class → node, object property → edge,
datatype property → property, plus **class hierarchies** (`rdfs:subClassOf` →
entity `extends`, see [Class hierarchies](#class-hierarchies-rdfssubclassof))
and **property hierarchies** (`rdfs:subPropertyOf` between object properties →
relationship `extends`, see [Property
hierarchies](#property-hierarchies-rdfssubpropertyof)).
Import is **one-way and lossy by design**: constructs with no native
semantic-model home — the inverse /
equivalence / disjointness cross-references, the property characteristics, the
set-level axioms, and per-term annotations (`rdfs:seeAlso`, `owl:deprecated`, …)
— are **not imported**. The result is a clean semantic model, never an OWL
document wrapped in opaque metadata. What maps and what drops is listed in [How
each OWL construct maps](#how-each-owl-construct-maps) and
[Limitations](#limitations); what one import did with each construct it read is
in its [coverage report](#6-coverage-report-proposed) (proposed).

## 1. The OWL file

`sales.owl.ttl` — an ontology header, two classes with keys, datatype
properties across several `xsd` types, and one object property. Nothing here
needs an OWL reasoner:

```turtle
@prefix owl:  <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
@prefix ex:   <http://example.com/sales#> .

<http://example.com/sales> a owl:Ontology ;
    rdfs:label      "Sales domain" ;
    rdfs:comment    "A minimal sales domain: customers and the orders they place." ;
    skos:example    "How many orders did each customer place last month?" ;
    owl:versionInfo "1.0" .

ex:Customer a owl:Class ;
    rdfs:label    "Customer" ;
    rdfs:comment  "A person or organization that places orders." ;
    skos:altLabel "Buyer" ;
    owl:hasKey ( ex:customerId ) .

ex:Order a owl:Class ;
    rdfs:label   "Order" ;
    rdfs:comment "A purchase placed by a customer." ;
    owl:hasKey ( ex:orderId ) .

# customerId is the key; email uniquely identifies a customer
# (inverse-functional) so it becomes a unique-key constraint.
ex:customerId a owl:DatatypeProperty ;
    rdfs:domain ex:Customer ;
    rdfs:range xsd:string .
ex:email a owl:DatatypeProperty,
        owl:InverseFunctionalProperty ;
    rdfs:domain ex:Customer ;
    rdfs:range xsd:string ;
    rdfs:comment "The customer's unique email address." .
ex:customerName a owl:DatatypeProperty ;
    rdfs:domain ex:Customer ;
    rdfs:range xsd:string ;
    rdfs:label "name" .
ex:signupDate a owl:DatatypeProperty ;
    rdfs:domain ex:Customer ;
    rdfs:range xsd:date .
ex:isVip a owl:DatatypeProperty ;
    rdfs:domain ex:Customer ;
    rdfs:range xsd:boolean ;
    rdfs:comment "Whether the customer is in the loyalty program." .

ex:orderId a owl:DatatypeProperty ;
    rdfs:domain ex:Order ;
    rdfs:range xsd:string .
ex:orderAmount a owl:DatatypeProperty ;
    rdfs:domain ex:Order ;
    rdfs:range xsd:decimal ;
    skos:example "19.99" .
ex:quantity a owl:DatatypeProperty ;
    rdfs:domain ex:Order ;
    rdfs:range xsd:integer .
ex:orderDate a owl:DatatypeProperty ;
    rdfs:domain ex:Order ;
    rdfs:range xsd:date .

ex:placedBy a owl:ObjectProperty ;
    rdfs:domain ex:Order ;
    rdfs:range ex:Customer ;
    rdfs:label "placed by" ;
    rdfs:comment "Links an order to the customer who placed it." .
```

The same ontology as an RDF graph. Every arc is a triple: a class (the subject)
points through a property (the predicate) to its object. Each **datatype
property** points to its `xsd` range — a literal type, drawn as a plain box —
and becomes a field. The **object property** `ex:placedBy` points from one class
to another and becomes the relationship. The two classes become the datasets.

```mermaid
graph LR
    Customer(["ex:Customer"])
    Order(["ex:Order"])

    Order -- "ex:placedBy" --> Customer

    Customer -- "ex:customerId" --> cid["xsd:string"]
    Customer -- "ex:email (inverse-functional)" --> cem["xsd:string"]
    Customer -- "ex:customerName" --> cnm["xsd:string"]
    Customer -- "ex:signupDate" --> csd["xsd:date"]
    Customer -- "ex:isVip" --> civ["xsd:boolean"]

    Order -- "ex:orderId" --> oid["xsd:string"]
    Order -- "ex:orderAmount" --> oam["xsd:decimal"]
    Order -- "ex:quantity" --> oqt["xsd:integer"]
    Order -- "ex:orderDate" --> odt["xsd:date"]

    classDef cls fill:#dae8fc,stroke:#6c8ebf,color:#000;
    classDef lit fill:#f5f5f5,stroke:#999999,color:#000;
    class Customer,Order cls;
    class cid,cem,cnm,csd,civ,oid,oam,oqt,odt lit;
```

Classes (rounded) are the resources that become datasets; the `xsd` boxes are
literal types that become each field's `datatype`.

## 2. The command

```console
$ kcmd owl import sales.owl.ttl
converted 2 classes, 1 object property, 9 datatype properties
wrote catalog/EntryGroups/<entryGroup>/sales.yaml
coverage (owl import of model 'sales'):
  construct                      compiled  hinted  dropped
  owl:Class                             2       0        0
  owl:hasKey                            2       0        0
  owl:DatatypeProperty                  9       0        0
  rdfs:range                            9       0        0
  owl:InverseFunctionalProperty         1       0        0
  rdfs:comment                          5       0        0
  rdfs:label                            4       0        0
  skos:example                          1       0        0
  owl:ObjectProperty                    1       0        0
  skos:altLabel                         1       0        0
  owl:Ontology                          1       0        0
  owl:versionInfo                       1       0        0
  total                                37       0        0
wrote catalog/EntryGroups/<entryGroup>/coverage.json
```

The model name comes from the file (`sales.owl.ttl` → `sales`); pass `--name
<model>` to choose another. By default the
document is written into the semantic-model layout dir so the next `kcmd push`
picks it up; pass `--out <path>` to write it elsewhere. The output uses the
block layout shown below; pass `--compact` for the compact flow layout
(`primary_key: [id]`, inline `{ name, datatype }` field and relationship maps)
instead. Either way it is a purely **logical** model — `kcmd push` publishes it
to Knowledge Catalog as-is, while a BigQuery or Spanner Graph deploy needs each
relationship's join columns added to the model plus a [binding
profile](profiles.md) (see [§4](#4-going-from-ontology-to-a-running-graph-binding)).

The `coverage` block is the coverage summary: every construct the import read,
counted by what became of it. The full report goes to the `coverage.json` named
on the last line (see [§6](#6-coverage-report-proposed)). The other examples on
this page leave both out. Three flags are proposed additions:

| Flag | Effect |
|---|---|
| `--prune-unbound [binding]` | Keep only the entities a binding gives a `source`, their ancestors and the defined entities over them, and print what was removed. See [§5](#5-pruning-to-what-is-bound-proposed). |
| `--coverage <path>` | Write the coverage report here instead of to `coverage.json` beside the written model. |
| `--no-coverage` | Print no coverage summary and write no coverage report. |

### Importing a modular ontology (several files)

A larger ontology is usually split into modules — a shared upper module plus one
module per domain — that refer to each other's terms. Give them all to one
import and they become **one** model:

```console
$ kcmd owl import core.ttl commercial.ttl finance.ttl --name ps_commercial
converted 24 classes, 18 object properties, 61 datatype properties
wrote catalog/EntryGroups/<entryGroup>/ps_commercial.yaml
```

The files are merged before anything is mapped (an RDF merge: each file keeps
its own `@prefix` scope, and blank nodes never collide across files), so every
rule on this page applies to the union:

- **Cross-file references resolve.** `com:ClientAccount rdfs:subClassOf
  core:Party`, a datatype property in one module whose `rdfs:domain` is a class
  in another, an edge whose `rdfs:range` lives elsewhere — all map as if they
  were in one file.
- **Order is the argument order.** Entities and fields appear in declaration
  order across the files as given, so a stable command line gives a stable
  document.
- **The first file's `owl:Ontology` header describes the model** (its
  description, labels, examples, version). A later module's header describes a
  dependency, not the model.
- **The model name** is `--name`, else the first file's stem.
- **The base namespace** (named in the description only when the header has
  none) is the one shared by most terms across all the files.

**`owl:imports`.** A module that imports another by IRI can be imported alone —
the dependency is followed to a **local file only**, never fetched:

```turtle
<https://example.org/ontology/commercial> a owl:Ontology ;
    owl:imports <https://example.org/ontology/core> .
```

```console
$ kcmd owl import commercial.ttl
following owl:imports: core.ttl
converted ...
```

An import is satisfied by a file already on the command line whose
`owl:Ontology` IRI is the imported one, or else by a file **beside the importing
file** named after the IRI's last segment (`core`, `core.ttl`, `core.owl.ttl`;
a `file:` IRI names its file directly) — accepted only when that file's own
`owl:Ontology` IRI matches (ignoring a trailing `#`/`/`). Imports are followed
transitively. An import that resolves to no such file is **warned and
skipped**; pass the file on the command line to include it.

## 3. The semantic model it produces — `sales.yaml`

The `Customer` dataset and the `placedBy` edge (the `Order` dataset follows the
same shape). The structure, keys, and values are exactly what the converter
emits; the inline `#` comments are annotations added here for the walkthrough —
the real output has none:

```yaml
version: 0.2.0.dev0/google
semantic_model:
  - name: sales
    description: "A minimal sales domain: customers and the orders they place.
      (ontology version 1.0)"
    ai_context:
      synonyms:
        - Sales domain
      examples:
        - How many orders did each customer place last month?
    entities:
      - name: Customer                   # no source: a logical entity
        primary_key:
          - customerId                   # from owl:hasKey
        unique_keys:
          - - email                      # from the inverse-functional property
        description: A person or organization that places orders.
        ai_context:
          synonyms:
            - Buyer
        fields:
          - name: customerId             # no expression: a logical field
            datatype: String
          - name: email
            datatype: String
            description: The customer's unique email address.
          - name: customerName
            datatype: String
            label: name
          - name: signupDate
            datatype: Date
            dimension:
              is_time: true              # a temporal field is a time dimension
          - name: isVip
            datatype: Boolean
            description: Whether the customer is in the loyalty program.
      # ... Order dataset: orderId, orderAmount, quantity, orderDate ...
    relationships:
      - name: placedBy
        from: Order                      # logical edge: direction only, no columns
        to: Customer
        ai_context:
          instructions: Links an order to the customer who placed it.
```

This is a purely **logical model**: an ontology declares meaning, not physical
tables, so entities carry no `source`, fields no `expression`, and relationships
no join columns. Before a graph deploy a [binding profile](profiles.md) supplies
the sources and field expressions, and you add each edge's join columns to the
model (they are logical, not a binding). The output carries no term IRIs and no
`custom_extensions`: a term's identity is its name, so a cleanly-mapped construct
needs nothing more. One kind of ontology goes further — a **class hierarchy**
(`rdfs:subClassOf`), shown next as an extension of *this same sales domain* (see
[Class hierarchies](#class-hierarchies-rdfssubclassof)). Everything OWL can say
that the semantic model cannot is **dropped on import**, not carried.

The source namespace is recorded only as a human-readable fallback: when the
ontology header has no comment of its own, the model `description` names the base
IRI it was imported from. This ontology has a header comment, so the namespace
appears nowhere above.

### How each OWL construct maps

| OWL | Semantic model | Notes |
|---|---|---|
| `owl:Ontology` header | model `description`, `ai_context`, version | comment → `description`; labels → `ai_context.synonyms`; `skos:example` → `ai_context.examples`; `owl:versionInfo` → appended to `description` |
| `owl:Class` | `datasets[]` entry | a logical entity — **no `source`** (a binding profile adds one before a graph deploy) |
| `owl:Class` with no `owl:hasKey` (own or inherited) that has subclasses | dataset `abstract: true` | a category — a label on its subtypes, not a table (see [Abstract classes](#abstract-classes-by-structure-kcmdabstract)); a keyless **leaf** stays concrete and is listed in the coverage report |
| `kcmd:abstract true` / `false` on a class | dataset `abstract` | overrides the structural rule either way; ignored (warned) on a vocabulary or defined class |
| `C owl:equivalentClass D` where `C` has no key and `D` has one | `C` folded into `D` | `C` is not imported: its relationships and fields move to `D`, its subclasses extend `D`, its name and labels become `D`'s `ai_context.synonyms`; warned (see [Folded equivalent classes](#folded-equivalent-classes)) |
| `kcmd:Metric` individual | `metrics[]` entry | name = local name, `expression` = `kcmd:expression`, `description` = `skos:definition` + `Unit: …` for `kcmd:unit`; see [Metrics](#metrics-kcmdmetric) |
| `owl:DatatypeProperty` | `fields[]` on **each** domain's dataset | a logical field — **no `expression`** (a binding profile maps it to a column). A property shared by several classes takes **one** union domain, `rdfs:domain [ owl:unionOf (A B) ]`, and lands on each member (several `rdfs:domain` triples mean the *intersection* in OWL; they are still accepted, landing on each, for backward compatibility). A union member that is not a named class is warned and skipped |
| `owl:ObjectProperty` | `relationships[]` | `from` = domain, `to` = range; a **logical edge with no join columns** (you add `from_columns`/`to_columns` to the model before a graph deploy, see [binding](#4-going-from-ontology-to-a-running-graph-binding)); with several `rdfs:domain`/`rdfs:range` values only the first of each is kept (a relationship is one source → one destination) and the rest are warned |
| `owl:inverseOf` | relationship `inverse` | the pair becomes **one** relationship whose `inverse:` names the reverse reading — never two edges (see [Inverse properties](#inverse-properties-owlinverseof)); a graph deploy emits it as a second edge label over the same backing table |
| `rdfs:subClassOf` (named superclass) | dataset `extends[]` | records the parent(s) in document order (see [Class hierarchies](#class-hierarchies-rdfssubclassof)) |
| `rdfs:subPropertyOf` (object property → object property) | relationship `extends[]`; the parent gets `abstract: true` | the super-property becomes an **abstract relationship** (a shared edge label, no edge table); a super-property missing `rdfs:domain`/`rdfs:range` takes the nearest common superclass of its sub-properties' ends (see [Property hierarchies](#property-hierarchies-rdfssubpropertyof)) |
| `owl:Restriction` via `rdfs:subClassOf` / `owl:equivalentClass` (cardinality, `someValuesFrom`, `allValuesFrom`, `hasValue`) | model `constraints[]` | a judged rule about the class's relationship (or a relationship's inverse name, read backwards) or field, e.g. `Opportunity_hasBuyer_exactly_1`, `Opportunity_governedBy_max_1`; see [Rules (restrictions, functional properties, disjointness)](#rules-restrictions-functional-properties-disjointness) |
| `owl:intersectionOf` on a class's `owl:equivalentClass` / `rdfs:subClassOf` | `extends[]` + model `constraints[]` | `C ≡ D ⊓ ∃p.X`: named conjunct `D` → `extends`, restriction conjunct → a constraint on `C`; union / complement conjuncts dropped |
| `owl:equivalentClass` class expression decidable on one row of the base | dataset `defined` + `extends: [parent]` | `WonOpportunity ≡ Opportunity ⊓ inStage value Stage_Won` → `defined: {expression: "LOWER(salesStage) = '5_won'"}` (string codes match case-insensitively); see [Defined classes](#defined-classes-owlequivalentclass) |
| `owl:FunctionalProperty` on an object property | model `constraints[]` | `<Domain>_<prop>_functional` — at most one edge per source; on a datatype property it is dropped (a field already holds one value) |
| `owl:disjointWith`, `owl:AllDisjointClasses` | model `constraints[]` | `A_disjoint_B`, `A_B_C_disjoint` — no instance is more than one of the classes |
| `owl:equivalentClass` / `owl:equivalentProperty` (named term) | `ai_context.synonyms` | the equivalent term's local name and its in-document `rdfs:label`, so NL search resolves either vocabulary to this term; not added when equal to the term's own name (or a field's `label`). See [Semantic annotations](#semantic-annotations-equivalence-deprecation-transitivity) |
| `owl:deprecated true` (+ `rdfs:seeAlso` replacement) | `description` prefix `DEPRECATED:` + `ai_context.instructions` | on an entity/field the description is prefixed; every deprecated term gets an instruction "do not use it in new queries or writes", naming the replacement when an `rdfs:seeAlso` points at an in-model term of the same kind |
| `owl:TransitiveProperty` / `owl:SymmetricProperty` (object property) | relationship `ai_context.instructions` | a query hint: transitive → a bounded quantified path `-[:rel]->{1,10}`; symmetric → an undirected match `-[:rel]-` |
| `owl:oneOf` (directly or as the class's `owl:equivalentClass`), a class with `owl:NamedIndividual` instances, or a class annotated `vocabulary true` | dataset `members` (proposed) | the class becomes a **vocabulary**; each individual a member: code from `skos:notation` or any annotation whose local name is `code`, label from `rdfs:label` / `skos:prefLabel`, order from a local name `sortOrder` / `order`; see [Vocabularies](#vocabularies-owloneof-named-individuals) |
| `owl:propertyChainAxiom` on an object property | relationship `via` (proposed) | `p owl:propertyChainAxiom ( [owl:inverseOf a] b )` → `via: [^a, b]`, a **derived relationship**; missing `rdfs:domain` / `rdfs:range` are inferred from the chain's ends; see [Property chains](#property-chains-owlpropertychainaxiom) |
| `encodedBy` (any annotation with that local name) on an object property | relationship `from_columns` / `to_columns` | the named datatype property holds the destination's code or key: the edge joins it (on the source or an ancestor) to the destination's single-column key — its own or the nearest keyed ancestor's, for a vocabulary or an ordinary keyed class alike. A composite or missing destination key leaves the edge logical, warned; see [Vocabularies](#vocabularies-owloneof-named-individuals) |
| `owl:propertyDisjointWith`, `owl:AllDisjointProperties`, `owl:AllDifferent`, the other property characteristics, `rdfs:subPropertyOf` between datatype properties, `rdfs:isDefinedBy`, `owl:versionInfo` on a term, `rdfs:seeAlso` other than a deprecation replacement | *(dropped)* | **no native home** — not imported (see [Limitations](#limitations)) |
| `rdfs:range xsd:*` | field `datatype` | see [Datatypes](#datatypes-rdfsrange) |
| `owl:hasKey ( ... )` | dataset `primary_key` | single or composite, in list order |
| `owl:InverseFunctionalProperty` | dataset `unique_keys` | a uniquely-identifying property; omitted when it is already the `primary_key`; a lone one on a keyless class is promoted to `primary_key` instead (not on a category whose subclasses have keys of their own); inherited as a unique key by concrete subclasses |
| `rdfs:label` on a datatype property | field `label` | the field's display name (a `label` slot exists only on fields); dropped when it only respaces/recases the name |
| `rdfs:label` on a class / object property | `ai_context.synonyms` | no `label` slot there, so a distinct label becomes an alternate name; dropped when redundant with the name |
| extra `rdfs:label` / `skos:altLabel` / `prefLabel` / `hiddenLabel` | `ai_context.synonyms` | genuinely alternate names; feed NL search |
| `skos:example` | `ai_context.examples` | sample questions / values |
| `rdfs:comment`, `skos:definition`, `dcterms:`/`dc:description` | `description` | first present wins, in that order; on an object property (which has no `description` slot) the comment rides in `ai_context.instructions` |
| `qudt:unit`, `qudt:hasUnit`, `om:hasUnit`, `schema:unitCode`, or any annotation whose local name is `unit` / `hasUnit` / `unitCode` / `unitOfMeasure`, on a datatype property | field `unit` | matched by the predicate's local name; an IRI object gives its local name (`unit:USD` → `USD`), a literal its trimmed text; first one wins. No `scale` is inferred |
| term IRIs, `@prefix` | dropped (base IRI named in `description` **only when the header has no comment of its own**) | a term's identity is its local name; the source namespace is not otherwise carried |

A datatype property whose domain is not a class, or an object property missing an
endpoint, cannot be placed; it is **skipped with a warning** rather than failing
the whole import. An object property that declares *more than one* `rdfs:domain`
or `rdfs:range` is kept — a relationship maps one source to one destination, so
the first of each is used and the extra endpoints are dropped with a warning
(unlike a multi-domain *datatype* property, which lands on every domain).

### Shared fields (`rdfs:domain [ owl:unionOf (...) ]`)

A key is usually also the foreign key of the classes that reference it:
`com:accountId` identifies a `ClientAccount` and records the account on an
`Opportunity`. Declare such a shared property with **one union domain**:

```turtle
com:accountId a owl:DatatypeProperty ; rdfs:range xsd:string ;
    rdfs:domain [ a owl:Class ; owl:unionOf ( com:ClientAccount com:Opportunity ) ] .
com:ClientAccount owl:hasKey ( com:accountId ) .
com:forAccount a owl:ObjectProperty ;
    rdfs:domain com:Opportunity ; rdfs:range com:ClientAccount ;
    core:encodedBy com:accountId .
```

The field lands on every member class (`ClientAccount.accountId`, its key, and
`Opportunity.accountId`), and `forAccount` joins `Opportunity.accountId` to
`ClientAccount.accountId`. Do **not** write several `rdfs:domain` triples
instead: OWL reads them as an **intersection** (an instance of the domain is a
`ClientAccount` *and* an `Opportunity`), which a reasoner would act on. The
importer still accepts that form for backward compatibility (the field lands
on each class), but the union is the correct one. Nested unions are
flattened; a member that is not a named class (an intersection, a
restriction) is warned and skipped, and listed as a dropped `rdfs:domain` in
the coverage report.

### Datatypes (`rdfs:range`)

`rdfs:range` sets a field's logical `datatype`. Physical width is not carried (it
belongs to the bound table, not the ontology), so several `xsd` types collapse
onto one logical type:

| `xsd` range | `datatype` |
|---|---|
| `string`, `normalizedString`, `token`, `anyURI`, `language`, `Name`, `NCName` | `String` |
| `integer`, `int`, `long`, `short`, `byte`, `nonNegativeInteger`, `positiveInteger`, `unsignedInt`, … (any width/sign) | `Integer` |
| `decimal` | `Decimal` |
| `float`, `double` | `Float` |
| `boolean` | `Boolean` |
| `date` | `Date` |
| `time` | `Time` |
| `dateTime` | `DateTime` |
| `dateTimeStamp` | `DateTimeTz` |
| anything else, or no `rdfs:range` | `Opaque` |

A temporal field (`Date` / `Time` / `DateTime` / `DateTimeTz`) is additionally
marked a **time dimension** (`dimension: { is_time: true }`), so downstream
BigQuery Graph / BI treats it as one.

### Keys (`owl:hasKey`, `owl:InverseFunctionalProperty`)

- **`owl:hasKey ( ... )`** on a class becomes the dataset's `primary_key` (its
  grain), in list order — single or composite. If any key column names no
  datatype property on the class (undeclared, or declared only on another class)
  it has no field to back it; because keeping only the columns that do exist
  would silently narrow a composite key to a possibly non-unique one, the
  **entire `primary_key` is dropped** with a warning rather than left to fail
  later at graph generation.
- An **`owl:InverseFunctionalProperty`** (a datatype property that uniquely
  identifies its subject) becomes a `unique_keys` constraint — unless it is
  already the `primary_key`, in which case it is not repeated. If a class
  declares **no `owl:hasKey`** but has exactly **one** single-column
  inverse-functional property, that property is promoted to the `primary_key`
  (with a warning) so the dataset has a grain; ambiguous cases (several unique
  keys, or a composite one) are left without a `primary_key`. The promotion
  is skipped on a **category whose subclasses declare keys of their own**
  (`core:unitName` on `OrgUnit`, over `MarketUnit` and `ServiceGroup` keyed by
  their codes): each subclass is identified by its own key, so the property
  stays a unique key and the category stays [abstract](#abstract-classes-by-structure-kcmdabstract).
- **Unique keys flow down `extends`.** Every concrete subclass (not abstract,
  not a defined entity, not a vocabulary) gets its ancestors' `unique_keys`
  after its own — `MarketUnit` has `primary_key: [marketUnitCode]` and
  `unique_keys: [[unitName]]` — so a lookup by name resolves on the table
  that backs it. Primary keys are not inherited this way: a subclass with no
  key of its own is identified by its nearest keyed ancestor's.

Keys are **logical grain**, not a binding — they are the entity's identity, so
they come across even though the model has no physical binding. They also tell
you which columns an edge's `to_columns` must reference when you add join columns
to the model; see [binding](#4-going-from-ontology-to-a-running-graph-binding).

### Class hierarchies (`rdfs:subClassOf`)

`rdfs:subClassOf` maps to a dataset's `extends` — the one keyword borrowed from
[Ossie's ontology proposal](https://github.com/apache/ossie/blob/main/ontology/ontology.md)
onto our existing `datasets`. Extend the sales domain with a `Person` base class
that `Customer` refines (`Customer rdfs:subClassOf Person`):

```turtle
ex:Person a owl:Class ;
    rdfs:comment "A human being." .
ex:fullName a owl:DatatypeProperty ;
    rdfs:domain ex:Person ;
    rdfs:range xsd:string .

ex:Customer a owl:Class ;
    rdfs:subClassOf ex:Person ;
    rdfs:comment "A person or organization that places orders." ;
    owl:hasKey ( ex:customerId ) .
# ... Customer's own datatype properties: customerId, email, customerName, … ...
```

the `Person` and `Customer` entities come out as (`Customer` carrying
`extends: [Person]`):

```yaml
  # Person is its own entity -- abstract, since it has no key and a subclass
  # (see Abstract classes below):
  - name: Person
    abstract: true
    description: A human being.
    fields:
      - name: fullName
        datatype: String
  # Customer records that it extends Person and keeps ONLY its own fields;
  # Person's fullName is NOT flattened down.
  - name: Customer
    extends:
      - Person
    primary_key:
      - customerId
    description: A person or organization that places orders.
    fields:
      - name: customerId
        datatype: String
      # ... email, customerName, signupDate, isVip (Customer's own) ...
```

Multiple superclasses are allowed (`extends: [Person, Employee]`, in document
order). A `subClassOf` whose object is a blank-node axiom is not a named class, so
it never becomes `extends` by itself: an `owl:Restriction` there becomes a
[constraint](#rules-restrictions-functional-properties-disjointness) instead,
and an `owl:intersectionOf` is read conjunct by conjunct — its named classes
join `extends` (as do those of an intersection given as `owl:equivalentClass`:
every `C ≡ D ⊓ …` is a `D`) and its restrictions become constraints. Any other
class expression is ignored. The implicit universal superclasses
`owl:Thing` / `rdfs:Resource` are ignored too (every class subclasses them, so
they carry no inheritance information).

Two boundaries to be clear about:

- **The import *records* the hierarchy; the BigQuery push *resolves* it.** The
  importer writes `Customer` with `extends: [Person]` and **only its own fields**.
  A **BigQuery** push then resolves that inheritance: it emits a `LABEL Person`
  clause on the `Customer` node table and flattens `Person`'s fields down (fields
  flow down; edges do not) — see [Class hierarchies (`extends` →
  labels)](reference.md#class-hierarchies-extends--labels). The **Knowledge Catalog** push
  publishes each entry with exactly the fields it declares and records the
  hierarchy as a `Specializes: Person.` paragraph on the subtype's entry (see
  [Class hierarchies on the catalog](reference.md#class-hierarchies-on-the-catalog)).
- **Relationships have their own hierarchy.** Entity `extends` never makes an
  edge inherit anything; property inheritance is a separate mapping, below.

A **vocabulary** under a class that carries fields (`GeographicRegion
rdfs:subClassOf OrgUnit`, where `OrgUnit` has `unitName`) does **not** get
`extends: [OrgUnit]`: a vocabulary's rows are its members, read through fixed
columns (code, label, sort order, definition, IRI), and it could not bind the
fields it would inherit. The import warns, and the coverage report lists the
`rdfs:subClassOf` as dropped with that reason. A parent that carries no fields
(a pure category) is kept.

### Abstract classes (by structure, `kcmd:abstract`)

A class with **no key** — no `owl:hasKey` of its own or on an ancestor, and no
inverse-functional property promoted to one — that **has subclasses** is a
category: a label its subtypes share, not something a table backs. It comes
out `abstract: true` (`Party` over `Organization` over keyed `ClientAccount`).
A keyed class is never made abstract, nor is a class that inherits a key.
Only subclasses with rows of their own count: a **defined** subclass (an
`owl:equivalentClass` class expression, imported as a filter over its parent's
rows) does not make its parent abstract, since the parent is what holds those
rows.

A keyless **leaf** class (no subclasses, or only defined ones) stays a concrete
entity with no `primary_key`; the coverage report lists it (`owl:hasKey
(absent)`, dropped) and a binding refuses to bind it until it has a key.

`kcmd:abstract` (`https://kcmd.dev/ns#abstract`) overrides the rule either way:
`ex:Note kcmd:abstract true` makes a leaf abstract, `ex:Organization
kcmd:abstract false` keeps a keyless parent concrete. Vocabularies and defined
classes are never abstract; `kcmd:abstract true` on one is warned and ignored.

### Folded equivalent classes

Two modules often name one concept twice, and only one says how instances are
identified: `fin:Counterparty owl:equivalentClass com:ClientAccount`, with the
key on `ClientAccount`. When exactly one side of a named `owl:equivalentClass`
has a key (own or inherited), the unkeyed class is **folded** into the keyed
one before mapping:

- it is not imported as an entity;
- every reference to it moves to the keyed class — an object property's
  `rdfs:range` / `rdfs:domain` (so `fin:hasPayer` points at `ClientAccount`,
  and its `encodedBy` join uses `ClientAccount`'s key), a datatype property's
  domain, its subclasses' `extends`, restriction fillers, disjointness;
- its local name and labels (`Counterparty`, `Payer`, `Bill-to party`) become
  the keyed entity's `ai_context.synonyms`;
- a metric expression qualified by its name (`Counterparty.x`) is rewritten to
  the keyed class;
- a warning names the fold, and the coverage report lists it
  (`owl:Class` → `entity ClientAccount (folded in)`,
  `owl:equivalentClass (folded)`).

Two keyed equivalent classes are two tables of one concept and both stay (the
equivalence is a synonym, see [Semantic
annotations](#semantic-annotations-equivalence-deprecation-transitivity)), as
do two unkeyed ones. A vocabulary or a class with its own class definition is
never folded.

### Property hierarchies (`rdfs:subPropertyOf`)

`rdfs:subPropertyOf` between two object properties maps to relationship
`extends` (a `/google` extension, see [Relationship
inheritance](inheritance.md#relationship-inheritance)). The super-property
becomes an **abstract relationship**: it keeps its `from`/`to` (so it still says
what it connects) but binds no join columns and deploys no edge table. Each
sub-property is an ordinary relationship that names it:

```turtle
ex:hasCounterparty a owl:ObjectProperty ;
    rdfs:domain ex:CommercialDocument ; rdfs:range ex:Organization .
ex:hasBuyer a owl:ObjectProperty ; rdfs:subPropertyOf ex:hasCounterparty ;
    rdfs:domain ex:Opportunity ; rdfs:range ex:Client .
ex:hasPayer a owl:ObjectProperty ; rdfs:subPropertyOf ex:hasCounterparty ;
    rdfs:domain ex:Invoice ; rdfs:range ex:Organization .
```

```yaml
relationships:
  - name: hasCounterparty
    from: CommercialDocument
    to: Organization
    abstract: true            # a shared edge label, no edge table
  - name: hasBuyer
    from: Opportunity
    to: Client
    extends: [hasCounterparty]
  - name: hasPayer
    from: Invoice
    to: Organization
    extends: [hasCounterparty]
```

On a graph push each concrete edge table carries `LABEL hasCounterparty NO
PROPERTIES`, so `MATCH (d)-[:hasCounterparty]->(o)` spans both edge tables —
the downstream effect `rdfs:subPropertyOf` means.

- **Inferred ends.** Super-properties are often declared with only a range (or
  nothing): `belongsToTerritory` in the fixture has `rdfs:range OrgUnit` and no
  domain. A relationship needs both ends, so the importer takes the **nearest
  common superclass** of the missing end across the super-property's
  sub-properties (direct and transitive), and says so in a warning. When the
  sub-properties' ends share no superclass the super-property cannot be placed:
  it is skipped with a warning, and its sub-properties keep their edge without
  the dangling `extends`. With a single sub-property the inferred end is that
  sub-property's own end.
- **Only object properties.** `rdfs:subPropertyOf` between datatype properties
  has no native home (fields do not inherit from fields) and is dropped.
- **Endpoints must narrow.** A sub-relationship's `from` and `to` must each be
  its parent's endpoint or a subtype of it (per entity `extends`). Otherwise a
  match on the parent label would return edges outside the parent's declared
  ends, and the loader flags them. The importer drops such a parent from
  `extends`, with a warning. This happens most often after a
  [vocabulary](#vocabularies-owloneof-named-individuals) detaches from its
  superclass: a `GeographicRegion` that was an `OrgUnit` no longer fits
  `belongsToTerritory`'s range, so `inRegion` stops extending it. The parent
  stays the abstract umbrella over the sub-properties that do fit.

### Rules (restrictions, functional properties, disjointness)

Some OWL axioms state a **rule** rather than a shape: *every opportunity has
exactly one buyer*, *a contract is governed by at most one MSA*, *no
opportunity is both won and lost*. Each becomes a native model-level
[constraint](actions.md#2-gate-it-with-a-constraint). Knowledge Catalog publishes it as a
governed entry that an agent can read, and an action that lists it in `guards`
is refused when its write would break the rule.

```turtle
ex:Opportunity rdfs:subClassOf [ a owl:Restriction ;
    owl:onProperty ex:hasBuyer ;
    owl:qualifiedCardinality "1"^^xsd:nonNegativeInteger ;
    owl:onClass ex:ClientAccount ;
    kcmd:onViolation "reject" ; kcmd:severity "high" ] .
ex:WonOpportunity owl:disjointWith ex:LostOpportunity .
```

imports as:

```yaml
    constraints:
      - name: Opportunity_hasBuyer_exactly_1
        judgment: Each Opportunity has exactly one hasBuyer relationship to a
          ClientAccount. An Opportunity with no hasBuyer relationship to a
          ClientAccount, or with more than one, does not satisfy this rule.
        description: "Link each Opportunity to exactly one ClientAccount through
          hasBuyer. (From OWL: Opportunity SubClassOf hasBuyer exactly 1
          ClientAccount.)"
        on_violation: reject
        severity: high
      - name: WonOpportunity_disjoint_LostOpportunity
        judgment: No WonOpportunity is also a LostOpportunity. An instance that is both
          a WonOpportunity and a LostOpportunity does not satisfy this rule.
        description: "Classify it as a WonOpportunity or a LostOpportunity, not both.
          (From OWL: WonOpportunity DisjointWith LostOpportunity.)"
        on_violation: warn
```

| OWL axiom on class `C`, property `p` | Constraint name | Rule |
|---|---|---|
| `owl:cardinality` / `owl:qualifiedCardinality N` on a relationship | `C_p_exactly_N` | exactly N `p` edges (to the `owl:onClass` filler, or to `p`'s range) |
| `owl:minCardinality` / `owl:minQualifiedCardinality N` | `C_p_min_N` | at least N edges |
| `owl:maxCardinality` / `owl:maxQualifiedCardinality N` | `C_p_max_N` | at most N edges |
| `owl:someValuesFrom X` | `C_p_some_X` | at least one edge to an `X` |
| `owl:allValuesFrom X` (`X` narrower than `p`'s range) | `C_p_only_X` | every `p` edge ends at an `X` |
| `owl:hasValue v` | `C_p_value_v` | an edge to `v` (relationship) or `C.p` equals `v` (field) |
| min/exact 1 or `someValuesFrom` on a **field** | `C_p_required` | `C.p` is never null |
| max/exact 0 on a field | `C_p_empty` | `C.p` is always null |
| `p a owl:FunctionalProperty` (object property) | `D_p_functional` | at most one `p` edge per source `D` |
| `A owl:disjointWith B` | `A_disjoint_B` | nothing is both an `A` and a `B` |
| `[] a owl:AllDisjointClasses ; owl:members (A B C)` | `A_B_C_disjoint` | nothing is more than one of them |

Details:

- **Where the restriction can sit.** As a blank-node `rdfs:subClassOf` object,
  as a lone `owl:Restriction` given as `owl:equivalentClass`, or as a conjunct
  of an `owl:intersectionOf` in either position (see *Intersections* below).
- **Resolving `p`.** `p` must be a relationship that starts at `C` or at one of
  its supertypes, a relationship's **inverse name** (see *Through an inverse*
  below), or a field of `C` or of one of its supertypes. The judgment names a
  field model-qualified (`Opportunity.opportunityId`), so constraint validation
  checks the reference.
- **Through an inverse.** An `X owl:inverseOf Y` property with no domain or
  range of its own is folded into `inverse: X` on relationship `Y` (see
  [Inverse properties](#inverse-properties-owlinverseof)), and a restriction on
  `X` is a rule about that same `Y` edge read backwards. `C` must be `Y`'s
  destination (or a subtype of it); the filler narrows `Y`'s **source**. The
  constraint keeps the axiom's name and its text names the forward edge:

  ```turtle
  ex:contractFor rdfs:domain ex:ContractAgreement ; rdfs:range ex:Opportunity ;
      owl:inverseOf ex:governedBy .
  ex:Opportunity rdfs:subClassOf [ a owl:Restriction ;
      owl:onProperty ex:governedBy ;
      owl:maxQualifiedCardinality "1"^^xsd:nonNegativeInteger ;
      owl:onClass ex:ContractAgreement ] .
  ```

  ```yaml
      - name: Opportunity_governedBy_max_1
        judgment: Each Opportunity is linked from at most one ContractAgreement
          via contractFor (governedBy is contractFor read backwards). An
          Opportunity linked from more than one does not satisfy this rule.
        description: "Link each Opportunity from at most one ContractAgreement
          through contractFor. (From OWL: Opportunity SubClassOf governedBy max
          1 ContractAgreement.)"
        on_violation: warn
  ```

  Every kind in the table maps the same way (`C_p_exactly_N`, `C_p_min_N`,
  `C_p_some_X`, `C_p_only_X`, `C_p_value_v`); an `allValuesFrom` naming `Y`'s
  own source is dropped, and a `FunctionalProperty` on `Y` is not treated as
  covering an inverse max 1 (it bounds the other direction).
- **Intersections.** A defined class `C ≡ D ⊓ ∃p.X` (`owl:equivalentClass [ a
  owl:Class ; owl:intersectionOf ( ex:D [ a owl:Restriction ; … ] ) ]`) whose
  definition one row of `D` can decide becomes a defined entity instead (see
  [Defined classes](#defined-classes-owlequivalentclass)); otherwise it is read
  conjunct by conjunct: each restriction conjunct becomes a constraint on `C`
  exactly as if stated alone, and each named conjunct `D` is added to `C`'s
  `extends` (deduped against its `rdfs:subClassOf`), since every `C` is a `D`.
  Nested intersections are flattened; a `unionOf` / `complementOf` conjunct
  is dropped silently (it states no rule every `C` must satisfy on its own).
  The provenance shows the whole axiom: `(From OWL: QAAssuredEngagement
  EquivalentTo Engagement and (hasHealthCheck some QAHealthCheck).)`. The
  constraint states the necessary direction only (every `C` satisfies the
  restriction); the "and conversely" half of `≡` — classifying any such `D`
  as a `C` — has no native construct and is not imported.
- **What is dropped silently.** Anything the semantic model already guarantees
  by construction:
  - a field's max N ≥ 1, `allValuesFrom`, and `FunctionalProperty` (a field
    holds one value);
  - an `allValuesFrom` naming `p`'s own range (an edge always ends at its
    declared destination);
  - `min 0`;
  - a pairwise `disjointWith` already covered by an `owl:AllDisjointClasses`
    set;
  - a `FunctionalProperty` already bounded by a max/exact 1 restriction on the
    same edge.
- **What is warned and skipped.**
  - an anonymous filler (e.g. `someValuesFrom [ owl:intersectionOf … ]`);
  - a `p` that resolves to neither a relationship (or a relationship's
    inverse) nor a field of `C`;
  - an edge that does not start at `C`, or — for an inverse name — does not
    end at `C`;
  - a field minimum above one;
  - a class not in the model.
- **Enforcement.** OWL says what must hold, but not what a violation does or
  how grave it is. Two optional annotation properties in the kcmd namespace
  (`@prefix kcmd: <https://kcmd.dev/ns#>`) supply both:
  - `kcmd:onViolation` takes `"reject"`, `"escalate"` or `"warn"`;
  - `kcmd:severity` takes `"critical"`, `"high"`, `"medium"` or `"low"`.

  Put them on the restriction node, the class, the property, or the
  `owl:AllDisjointClasses` node. For each of the two annotations, the most
  specific one wins: restriction, then class, then property. Without an
  annotation, `on_violation` is `warn` (an imported rule informs until someone
  decides it should block) and there is no `severity`. An invalid value is
  warned and ignored.
- **Description.** It is the violation message: an `rdfs:comment` on the
  restriction node if there is one, otherwise a generated instruction. Either
  way it ends with the source axiom in Manchester-like syntax.
- **Order and names.** Constraints come out in a fixed order:
  1. each class's restrictions, in class order;
  2. functional properties;
  3. disjoint pairs;
  4. disjoint sets.

  Names are sanitized to letters, digits and `_`, and made unique with a `_2`
  suffix when needed.

### Defined classes (`owl:equivalentClass`)

A vocabulary code compared on a string column matches case-insensitively
(`LOWER(salesStage) = '5_won'`): codes are identifiers, and source systems
often store variants such as `5_Won`, which an exact match would silently drop
from the class.

An `owl:equivalentClass` class expression states necessary **and sufficient**
conditions. When one row of an existing entity can decide them, the class
becomes a [defined entity](inheritance.md#defined-entities-a-subtype-picked-out-by-a-condition):
`defined.expression` is the test in SQL over field names, and `extends` is its
single parent. That entity is the class's **base**, its nearest superclass
that is not itself defined.

```turtle
com:Stage_Won a owl:NamedIndividual , com:SalesStage ; core:code "5_won" .
com:inStage a owl:ObjectProperty ; rdfs:domain com:Opportunity ;
    rdfs:range com:SalesStage ; core:encodedBy com:salesStage .

com:WonOpportunity a owl:Class ; rdfs:subClassOf com:ClosedOpportunity ;
    owl:equivalentClass [ a owl:Class ; owl:intersectionOf ( com:Opportunity
        [ a owl:Restriction ; owl:onProperty com:inStage ;
          owl:hasValue com:Stage_Won ] ) ] .
```

```yaml
- name: WonOpportunity
  extends: [ClosedOpportunity]
  defined:
    expression: LOWER(salesStage) = '5_won'
```

The compilation follows the ontology prototype's reference compiler:

| Class expression | SQL |
|---|---|
| a named class on the base's lineage | `TRUE` (dropped from a conjunction) |
| another defined class over the same base | its definition, expanded inline |
| `intersectionOf` / `unionOf` / `complementOf` | `AND` / `OR` / `NOT (…)` |
| `p hasValue "lit"` (datatype property) | `p = 'lit'` (typed by the literal / field) |
| `p hasValue :ind` (object property with `encodedBy` column `c`) | `c = '<code of :ind>'` |
| `p some` / `min 1` / `exactly 1` (range or `owl:Thing`) on an `encodedBy` property | `c IS NOT NULL` |
| `p some ({:a :b})` on an `encodedBy` property | `c IN ('<code a>', '<code b>')` |
| `p some [xsd:decimal minInclusive 1000]` (also `min/maxExclusive`, `maxInclusive`, `pattern`, `length`, `minLength`, `maxLength`) | `p >= 1000` (`REGEXP_CONTAINS`, `CHAR_LENGTH`) |
| `p some [ owl:oneOf ("A" "B") ]` (data enumeration) | `p IN ('A', 'B')` |
| `p some xsd:string` / `min 1` / `exactly 1` (datatype property) | `p IS NOT NULL` |
| `p only R` | `(p IS NULL OR R)` |
| `p max 0` / `exactly 0` | `p IS NULL` |

- **Codes.** An individual's code is its `kcmd:code`, else `skos:notation`, else
  any `…code` property (the prototype's `core:code`). An individual with no
  code compiles to its local name, with a warning. `encodedBy` is read from any
  property with that local name (`core:encodedBy`, `kcmd:encodedBy`) and names
  the field that stores the code.
- **Hierarchy.** The parent is the most specific superclass that is the base or
  a defined class over the same base, so `Won ⊑ Closed ⊑ Opportunity` keeps
  `WonOpportunity extends ClosedOpportunity`. Other superclasses are dropped
  with a warning. A non-defined subclass of a defined class is re-pointed at its
  base, with a warning.
- **Not restated as rules.** A compiled class's `owl:equivalentClass`
  restrictions are its definition, so they do not also become constraints.
  Its `rdfs:subClassOf` restrictions and disjointness still do.
- **String comparisons are exact.** The prototype lower-cases both sides; the
  importer compares as written.
- **Fallback.** Some definitions need a join, above all a restriction that
  traverses a relationship with no `encodedBy` column, e.g. `hasBuyer some
  StrategicAccount`. Others reduce to `TRUE` or `FALSE`, or the class has no
  superclass. None of these can be a filter. The class has no fields or key of
  its own, so it has no rows to bind either: as a concrete entity it would be a
  keyless node that no binding can satisfy and a graph deploy rejects. It is
  therefore imported **abstract**: no node of its own, and its
  [restrictions](#rules-restrictions-functional-properties-disjointness) still
  become constraints. Its definition is written in Manchester syntax into
  `ai_context.instructions`, so an agent can still evaluate membership over the
  base. The warning names the reason:

  ```
  class 'PriorityOpportunity': its owl:equivalentClass definition was not
  compiled to a defined entity (unsupported: a restriction on object property
  'hasBuyer', which traverses a relationship and has no encodedBy code column
  on 'Opportunity'); imported as an abstract entity with constraints, its
  definition in ai_context.instructions.
  ```

  ```yaml
  - name: PriorityOpportunity
    extends: [Opportunity]
    abstract: true
    ai_context:
      instructions: >-
        Membership is defined, not stored: a PriorityOpportunity is Opportunity
        and (HighValueOpportunity or (hasBuyer some StrategicAccount)). No
        PriorityOpportunity rows or nodes exist; to find its members, evaluate
        this definition over Opportunity and its relationships.
  ```

  `kcmd:abstract false` on the class keeps it concrete. A class with fields or
  a key of its own is a table-backed subtype rather than a filter, so it keeps
  the [intersection](#rules-restrictions-functional-properties-disjointness)
  import: `extends` plus constraints, with a warning. A top-level `owl:oneOf`
  of individuals (a closed vocabulary such as an order-status list) is not a
  definition; it imports as a
  [vocabulary](#vocabularies-owloneof-named-individuals) (proposed).

### Semantic annotations (equivalence, deprecation, transitivity)

Some OWL facts have no structural slot but real value for a consumer — an NL
agent choosing which term to query, or a person writing GQL. They map onto the
model's native `ai_context` (and, for deprecation, `description`), which the
Knowledge Catalog push publishes and agents read:

```turtle
ex:Client a owl:Class ;
    owl:equivalentClass ex:Customer ;           # a named, in-model class
    owl:deprecated true ;
    rdfs:seeAlso ex:Customer .                  # the replacement
ex:Customer a owl:Class ; rdfs:label "Customer" .
ex:reportsTo a owl:ObjectProperty, owl:TransitiveProperty ;
    rdfs:domain ex:Employee ; rdfs:range ex:Employee .
```

```yaml
  - name: Client
    description: DEPRECATED.
    ai_context:
      instructions: "Client is deprecated: do not use it in new queries or writes. Use Customer instead."
      synonyms: [Customer]
  # ...
relationships:
  - name: reportsTo
    from: Employee
    to: Employee
    ai_context:
      instructions: "reportsTo is transitive: if a reportsTo b and b reportsTo c, then a reportsTo c, but only the direct edges are stored. To follow it, match a quantified path, e.g. MATCH (a:Employee)-[:reportsTo]->{1,10}(b:Employee) (raise the upper bound for deeper chains)."
```

- **Equivalence** (`owl:equivalentClass` / `owl:equivalentProperty` naming a
  term, in or out of the model) adds that term's local name — and its
  `rdfs:label`, when it is declared in the imported document — to the term's
  `ai_context.synonyms`. A synonym equal to the term's own name (e.g. `ex:Person
  owl:equivalentClass foaf:Person`) or to a field's `label` is not repeated. An
  anonymous class expression is not a named term and adds nothing.
- **Deprecation** (`owl:deprecated true`) prefixes an entity's or field's
  `description` with `DEPRECATED:` (just `DEPRECATED.` when it has none) and
  adds an instruction telling an agent not to use the term in new queries or
  writes. A relationship has no `description`, so it gets the instruction only.
  When the term's `rdfs:seeAlso` names an in-model term of the same kind (class
  → entity, property → field/relationship) the instruction names it as the
  replacement (`Use Customer instead.`, or `Use Person.fullName instead.` for a
  field); any other `seeAlso` is dropped.
- **Transitive / symmetric** object properties get a query hint on the
  relationship: a bounded quantified path (`-[:rel]->{1,10}`) for a transitive
  one, since only direct edges are stored, and an undirected match (`-[:rel]-`)
  for a symmetric one, since each pair may be stored in one direction only.

Instructions from several sources (an object property's `rdfs:comment`,
deprecation, a characteristic) are joined with a blank line, comment first.

### Inverse properties (`owl:inverseOf`)

`X owl:inverseOf Y` says X is Y **read backwards** — the same links, traversed
from the other end. The semantic model says exactly that with the
relationship's `inverse:` key, so the pair becomes **one** relationship, never
two (two relationships would deploy as two unrelated edges that a query could
see disagree):

```turtle
ex:placedBy a owl:ObjectProperty ;
    rdfs:domain ex:Order ; rdfs:range ex:Customer .
ex:places a owl:ObjectProperty ;
    owl:inverseOf ex:placedBy .          # no domain / range of its own
```

```yaml
relationships:
  - name: placedBy
    from: Order
    to: Customer
    inverse: places                      # Customer -[places]-> Order
```

Which side becomes the relationship:

- A side with **no `rdfs:domain` / `rdfs:range` of its own** folds into the
  side that has them — the common pattern where an ontology declares only
  `X owl:inverseOf Y` and lets the ends follow from Y.
- When **both** declare ends, they must mirror (X's domain is Y's range and
  vice versa); then the side stating `owl:inverseOf` folds into its referent.
  Ends that do **not** mirror are not one edge read two ways: both are kept as
  separate relationships, with a warning.
- A referent the ontology never declares as a property but that lies in its
  own namespace (`ex:placedBy owl:inverseOf ex:places`, no `ex:places`
  declaration) is still the name of the reverse reading, so it becomes
  `inverse: places` as-is. An external referent is warned and ignored.
- A relationship carries one inverse: an extra `owl:inverseOf` is warned and
  ignored (first wins), and an inverse name that collides with an entity or
  relationship name is dropped with a warning (graph labels share one
  namespace).

On a **BigQuery / Spanner Graph** deploy the inverse becomes a second edge table
over the **same** backing table with `SOURCE` / `DESTINATION` swapped, so both
`MATCH (o:Order)-[:placedBy]->(c:Customer)` and
`MATCH (c:Customer)-[:places]->(o:Order)` work with no data duplicated. On a
**Knowledge Catalog** push the inverse rides in the link's description as an
`Inverse: places.` trailer, which pull reads back (see [Relationship
inverses](reference.md#relationship-inverses-inverse)).

### Vocabularies (`owl:oneOf`, named individuals)

*Proposed.* A class whose instances are a closed list of coded values
(statuses, stages, categories) imports as a **vocabulary**: a dataset with
`members` (see [Extensions](model_spec.md#5-extensions)). A class is a
vocabulary when any of these holds:

- it carries a class-level boolean annotation whose predicate local name is
  `vocabulary`, set to true (`ex:vocabulary true`, `kcmd:vocabulary true`);
- it is an enumeration, with `owl:oneOf ( … )` on the class or on its
  `owl:equivalentClass`;
- one of its direct instances is declared `owl:NamedIndividual` in the
  imported files. This case is warned, so the reclassification is visible.

The same annotation set to `false` keeps a class a data class, whatever else
holds.

```turtle
ex:OrderStatus a owl:Class ;
    ex:vocabulary true ;
    owl:hasKey ( ex:statusCode ) .
ex:statusCode a owl:DatatypeProperty ;
    rdfs:domain ex:OrderStatus ; rdfs:range xsd:string .
ex:Open a owl:NamedIndividual, ex:OrderStatus ;
    ex:code "OPEN" ; ex:sortOrder 1 ; rdfs:label "Open" .
ex:Shipped a owl:NamedIndividual, ex:OrderStatus ;
    ex:code "SHIPPED" ; ex:sortOrder 2 ; rdfs:label "Shipped" ;
    skos:definition "Left the warehouse." .

ex:hasStatus a owl:ObjectProperty ;
    rdfs:domain ex:Order ; rdfs:range ex:OrderStatus ;
    ex:encodedBy ex:statusKey .            # Order.statusKey holds the code
ex:statusKey a owl:DatatypeProperty ;
    rdfs:domain ex:Order ; rdfs:range xsd:string .
```

becomes

```yaml
entities:
  - name: OrderStatus
    primary_key:
      - statusCode
    fields:
      - name: statusCode
        datatype: String
    members:
      - code: OPEN
        label: Open
        order: 1
        iri: http://example.com/sales#Open
      - code: SHIPPED
        label: Shipped
        definition: Left the warehouse.
        order: 2
        iri: http://example.com/sales#Shipped
  # ...
relationships:
  - name: hasStatus
    from: Order
    to: OrderStatus
    from_columns:
      - statusKey
    to_columns:
      - statusCode
```

The members are the enumeration's individuals in list order, then the class's
other direct instances in document order. They are then sorted by `order`;
members without one keep their relative place, after those with one. Each
member reads:

| Member key | OWL source (first present wins) |
|---|---|
| `code` | `kcmd:code`, else `skos:notation`, else any literal annotation whose local name is `code` (`ex:code`), else the individual's local name |
| `label` | `rdfs:label`, else `skos:prefLabel`, else the local name when it differs from the code |
| `synonyms` | the remaining labels: further `rdfs:label` / `skos:prefLabel` values, `skos:altLabel`, `skos:hiddenLabel` |
| `definition` | `skos:definition`, else `rdfs:comment`, else `dcterms:` / `dc:description` |
| `order` | an annotation whose local name is `sortOrder` or `order`, when it is an integer (otherwise warned and ignored) |
| `iri` | the individual's IRI |

Codes are matched case-insensitively downstream. A member whose code repeats
another's in any case is therefore dropped with a warning (the first wins). A
class that also compiles to a [defined entity](#defined-classes-owlequivalentclass)
keeps its definition, and its members are not imported (warned). A vocabulary
with no individuals in the imported files gets an empty member list (warned).

**`encodedBy` gives an edge its join columns.** `<objectProperty>
<ns>:encodedBy <datatypeProperty>` (any namespace; the predicate is matched by
its local name) states that the edge is stored as a code field on its source.
The import then joins that field to the destination's key, so an edge into a
vocabulary needs no hand-written `from_columns` / `to_columns`. The field
must belong to the source or to a class the source extends, and the
destination must have a single-column key; otherwise the edge stays logical,
with a warning. The same annotation lets a [defined
class](#defined-classes-owlequivalentclass) test a code.

On a BigQuery push the vocabulary needs no table and no profile binding.
kcmd generates the view `vocab_<snake_case(class)>` from the members, with
the columns `code`, `label`, `sort_order`, `definition` and `iri`, and the
edge matches each foreign key to a code case-insensitively. To deploy the
view somewhere specific, bind the vocabulary's `source` to a table named
`vocab_<snake_case(class)>`; a source naming any other table is read as-is,
and the members only document it.

### Property chains (`owl:propertyChainAxiom`)

*Proposed.* A property chain says one object property holds wherever a
sequence of others does. It imports as a **derived relationship** whose
`via` lists the steps (see [Extensions](model_spec.md#5-extensions)):

```turtle
ex:memberOf a owl:ObjectProperty ; rdfs:domain ex:Membership ; rdfs:range ex:Customer .
ex:inClub   a owl:ObjectProperty ; rdfs:domain ex:Membership ; rdfs:range ex:Club .
ex:belongsTo a owl:ObjectProperty ;      # no domain / range of its own
    owl:propertyChainAxiom ( [ owl:inverseOf ex:memberOf ] ex:inClub ) .
```

```yaml
relationships:
  - name: belongsTo        # Customer -> Membership -> Club
    from: Customer
    to: Club
    via:
      - ^memberOf
      - inClub
```

- A named step follows the property. A `[ owl:inverseOf p ]` step walks it
  backwards (`^p`). A step naming a property that was folded into another
  relationship's `inverse:` is rewritten as that relationship walked the
  other way, so the chain never depends on the inverse name.
- A chain property may omit `rdfs:domain` / `rdfs:range`. The entity where
  the chain starts, and the one where it ends, stand in, with a warning. A
  declared end, or one inferred from subproperties, wins. Chains through
  other chain properties resolve in any order.
- A chain property that is also a superproperty stays a concrete derived
  relationship (warned): its pairs are its own edges, and its subproperties
  still carry its label.
- These chains are not imported, each with a warning: a single-step chain, a
  chain naming the property itself (recursive, so no fixed join can
  materialize it), and a step other than a named property or `owl:inverseOf`.
  Only the first of several chains on one property is imported.
- The import runs the loader's chain checks, so a chain whose steps do not
  connect is already reported by `owl import`.

The import summary counts both features:
`converted N classes, … (V vocabularies, D derived relationships)`, shown only
when there are any.

### SKOS vocabulary (business glossary)

An ontology that ships its business vocabulary as SKOS concepts gets a
[business glossary](glossary.md) (`glossary:`) on the imported model, ready for
`kcmd glossary push`. The mapping is deliberately simple:

| SKOS | glossary | notes |
|---|---|---|
| `skos:Concept` | term | id from the local name, kebab-cased (`GrossSales` → `gross-sales`); repeats get a numeric suffix |
| `skos:prefLabel` (else `rdfs:label`) | `display_name` | English, else untagged, else any language |
| `skos:definition` (else `rdfs:comment`, `dcterms:description`) | `definition` | |
| `skos:altLabel`, `skos:hiddenLabel` | `synonyms` | English or untagged labels only |
| `skos:related` | `related` | both directions |
| `skos:inScheme` / `skos:topConceptOf` | `category` | one category per scheme when there are several; a single scheme describes the glossary itself (its label and definition become the glossary's) |
| `dcterms:subject`, `rdfs:seeAlso`, `skos:exactMatch`, `skos:closeMatch` naming an imported class / datatype property / metric | `defines` | a class → `{entity}`, a datatype property → `{field: Domain.property}`; a `dcterms:subject` that names nothing imported is warned |
| a concept that is itself an `owl:Class` or datatype property | `defines` (itself) | |
| `dcterms:source` | `source` | |

```turtle
ex:GrossSales a skos:Concept ;
  skos:prefLabel "Gross Sales"@en ;
  skos:altLabel "gross revenue"@en ;
  skos:definition "Order value before returns."@en ;
  skos:related ex:NetSales ;
  dcterms:subject ex:total .          # ex:total rdfs:domain ex:Order
```

becomes

```yaml
glossary:
  terms:
    - id: gross-sales
      display_name: Gross Sales
      definition: Order value before returns.
      synonyms: [gross revenue]
      related: [net-sales]
      defines:
        - field: Order.total
```

An ontology with no `skos:Concept` gets no `glossary:` block, so existing
imports are unchanged.

When a glossary is emitted, every imported [metric](#metrics-kcmdmetric) that
no concept already defines gets a term of its own, `defines: [{metric: …}]`,
with the metric's `skos:prefLabel` as display name, its `skos:definition` and
its `skos:altLabel`s as synonyms. A metric that is also typed `skos:Concept`
is that concept's term. No glossary is created only to hold metric terms.

### Metrics (`kcmd:Metric`)

Business KPIs can live in the ontology, next to the classes they measure, as
individuals of `kcmd:Metric` (`https://kcmd.dev/ns#Metric`):

```turtle
kcmd:Metric a owl:Class .   # declared so OWL tools accept the individuals
met:win_rate_pct a kcmd:Metric ;
    skos:prefLabel "Win rate percentage" ;
    skos:altLabel "win rate" , "close rate" ;
    kcmd:expression "100 * SAFE_DIVIDE(COUNTIF(LOWER(Opportunity.salesStage) = '5_won'), COUNTIF(LOWER(Opportunity.salesStage) IN ('5_won', 'closed_lost')))" ;
    skos:definition "Won opportunities as a percentage of closed opportunities." ;
    kcmd:instructions "Only closed opportunities are in the denominator." ;
    kcmd:unit "percent" .
```

becomes

```yaml
metrics:
  - name: win_rate_pct
    expression: 100 * SAFE_DIVIDE(COUNTIF(LOWER(Opportunity.salesStage) = '5_won'), ...)
    description: |-
      Won opportunities as a percentage of closed opportunities.

      Unit: percent.
    ai_context:
      instructions: Only closed opportunities are in the denominator.
      synonyms: [Win rate percentage, win rate, close rate]
```

| OWL | metric | notes |
|---|---|---|
| local name | `name` | |
| `kcmd:expression` | `expression` | written over the ontology's own `<Class>.<property>` names, never tables or columns (a binding maps those); a qualifier naming a [folded](#folded-equivalent-classes) class is rewritten to the keyed class |
| `skos:definition` (else `rdfs:comment`, `dcterms:description`) | `description` | |
| `kcmd:unit` (or any unit predicate, as on fields) | `description` trailer `Unit: X.` | the convention fields use where a slot is missing |
| `skos:prefLabel`, `rdfs:label`, `skos:altLabel`, `skos:hiddenLabel` | `ai_context.synonyms` | prefLabel first; the name itself is dropped |
| `kcmd:instructions` | `ai_context.instructions` | |
| the one entity the expression references | attach entity | derived as the loader derives it; none for a cross-entity metric |

`kcmd:Metric` and the other `kcmd:` terms are never imported as entities or
fields, and metric individuals are not vocabulary members. A metric with no
`kcmd:expression` is skipped with a warning; so is a second metric with the
same name. The import summary counts the metrics (`… (M metrics)`), and the
coverage report lists each one (`kcmd:Metric`, compiled or dropped, plus
`kcmd:Metric (glossary)` for its glossary term).

## 4. Going from ontology to a running graph (binding)

The import gives you a **logical model**: what the domain means, with no physical
binding. That is directly useful — `kcmd push` publishes it to
Knowledge Catalog as-is, so the ontology becomes catalog metadata (entities,
fields, and keys) with nothing more to fill in:

```console
$ kcmd push                  # publishes the logical model to Knowledge Catalog
```

A relationship publishes as a catalog link only once it has join columns (added
to the model, below); a column-less edge is skipped with a warning, so the
entities and fields still publish while the edge waits.

A **BigQuery or Spanner Graph** deploy needs two things the import leaves open,
and they belong in different places:

1. **The join columns on each edge — in the model.** The import gives every
   relationship its endpoints (`from`/`to`) but no join columns; which columns an
   edge joins on is a *logical* fact the model owns, not a physical binding, so
   you add it to the imported model itself. The keys the import already recovered
   (`primary_key`, `unique_keys`) tell you which columns an edge's `to_columns`
   must reference:

   ```yaml
   # sales.yaml — add the join columns to the imported relationship
   relationships:
     - name: placedBy
       from: Order
       to: Customer
       from_columns: [o_custkey]   # the Order-side foreign key
       to_columns: [customerId]    # Customer's key column
   ```

   An edge whose object property is annotated `encodedBy` already has its
   join columns. A vocabulary needs no table: a BigQuery push generates its
   view from the members (proposed; see
   [Vocabularies](#vocabularies-owloneof-named-individuals)). A derived
   relationship needs no join columns: its edges are generated from its chain
   (see [Property chains](#property-chains-owlpropertychainaxiom)).

2. **The physical binding — in a profile.** Which table each entity reads, which
   column each field reads, and the deployment target go in a
   [binding profile](profiles.md): a document in the same schema, kept beside the
   model as `<model>.profiles/<name>.yaml`, that adds *only* the binding and
   leaves the logical model untouched. A profile may set `source`, field
   `expression`, and `deployment_target` — nothing logical (a `relationships`
   block in a profile is rejected). A field the profile does not bind is left
   unbound; there is no separate flag. The model and the profile merge by name at
   push time:

   ```yaml
   # sales.profiles/warehouse.yaml — physical binding for the sales model
   version: 0.2.0.dev0/google
   semantic_model:
     - name: sales
       deployment_target: //bigquery.googleapis.com/projects/myproj/datasets/sales/propertyGraphs/sales
       datasets:
         - name: Customer
           source: //bigquery.googleapis.com/projects/myproj/datasets/sales/tables/customers
           fields:
             - { name: customerId, expression: c_custkey }
             - { name: email,      expression: c_email }
             # ... the remaining Customer fields ...
         - name: Order
           source: //bigquery.googleapis.com/projects/myproj/datasets/sales/tables/orders
           fields:
             - { name: orderId, expression: o_orderkey }
             # ... the remaining Order fields ...
   ```

   **Binding an imported hierarchy.** The import writes a subclass with only its
   own fields plus `extends`, so a field declared on a superclass lives only on
   the superclass. Bind it on each concrete subclass anyway, by the subclass's
   name — the profile accepts a field the entity inherits through `extends`
   (transitively) exactly like one it declares. A superclass with no table of
   its own is marked `abstract: true` in the model (a concrete entity must have a
   `source`), and the profile binds nothing on it:

   ```yaml
   # model: Person is abstract and declares fullName; Customer extends [Person]
   datasets:
     - name: Customer
       source: //bigquery.googleapis.com/projects/myproj/datasets/sales/tables/customers
       fields:
         - { name: customerId, expression: c_custkey }
         - { name: fullName,   expression: c_name }   # inherited from Person
   ```

   The graph then reads `c_name` both for `Customer`'s own label and for the
   `LABEL Person` clause on the `customers` node table. An inherited field left
   out of the profile is unbound, like any other.

With the join columns in the model and the profile in place, a single push
deploys the graph:

```console
$ kcmd push --profile warehouse   # merges the binding, then CREATE OR REPLACE PROPERTY GRAPH + KC entries
```

See [One logical model, many physical bindings](profiles.md) for the full profile
contract — what a profile may and may not set, how merge and prune work, and how
one logical model binds to several stores.

## 5. Pruning to what is bound (proposed)

A large ontology declares far more classes than one deployment binds to tables:
upper-ontology concepts, classes another team owns, vocabulary the model only
refers to. `--prune-unbound` keeps only what a binding can use, so the written
model, its catalog entries and every review stay the size of the deployment.
It keeps:

- the **bound** entities: those the binding gives a `source`;
- their **ancestors** (transitive `extends`): they stay labels on the bound
  subtypes, and their fields flatten down;
- the **defined** entities whose base is kept: each is a membership filter over
  a kept table, not a table of its own (see [Defined
  classes](#defined-classes-owlequivalentclass)).

Everything else is removed, together with what refers to it:

- relationships with a removed endpoint;
- abstract relationships left with no sub-relationship, and `extends`
  references to a removed relationship;
- constraints whose rule or description names a removed entity or
  relationship;
- glossary `defines` links to a removed entity. The term itself stays: it is
  vocabulary.

The binding is a [binding profile](profiles.md), or any model document with
inline bindings; only entities with a non-empty `source` count. The import looks
for it in this order:

1. the path given to the flag: `--prune-unbound model/shop.profiles/bigquery.yaml`;
2. with the bare flag, the model's binding profiles in the scope's
   semantic-model layout (`<model>.profiles/*.yaml`);
3. else the `<model>.profiles/*.yaml` beside `--out`.

The import fails, and writes nothing, when no binding is found, when the named
file does not exist, or when the binding binds no entity of the model (pruning
would remove everything). A bound name that is not an entity of the model is
warned about and ignored.

Take an ontology where `Customer` and `Supplier` extend `Party`, `LargeOrder`
is defined over `Order`, and `Shipment` and `Department` have no table. Its
relationships are `placedBy` and `suppliedBy` (both extending the abstract
`involves`, `Order` → `Party`), `shippedIn` and `partOf`. The profile binds
`Customer` and `Order`:

```console
$ kcmd owl import ontology/shop.ttl --out model/shop.yaml --prune-unbound
--prune-unbound: 2 bound entities in model/shop.profiles/bigquery.yaml
converted 7 classes, 6 object properties, 6 datatype properties
pruned to the bound entities: kept 4 entities (2 bound, 1 ancestor, 1 defined); removed 3 entities, 3 relationships, 1 constraint
  removed entities: Supplier, Shipment, Department
  removed relationships: suppliedBy, shippedIn, partOf
  removed constraints: Order_shippedIn_max_1
  removed glossary links: shipment-term -> Shipment
wrote model/shop.yaml
```

The `converted` counts are those of the whole ontology, before pruning.
`involves` stays because `placedBy`, which extends it, is kept. The coverage
report that follows lists each removed element as `dropped`, with a reason that
starts `pruned (--prune-unbound):`, and records the removed names under
`pruned` (see [§6](#6-coverage-report-proposed)).

This is not the pruning `kcmd push` does. A push that deploys a graph records
only the bound view in Knowledge Catalog but leaves the model document whole.
`--prune-unbound` removes the unbound part from the document itself, so every
later push, skill and review sees only what is bound. After binding more
entities, re-run the import with the flag.

## 6. Coverage report (proposed)

The warnings an import prints explain single gaps. The coverage report shows the
whole import: every occurrence of every construct the importer recognizes, each
with one outcome.

| Outcome | Meaning |
|---|---|
| `compiled` | It became a native part of the model: an entity, a field, a key, `extends`, a relationship or its `inverse`, a defined entity's membership predicate, a constraint, or an annotation in its own slot (`description`, field `label`, `ai_context.synonyms` or `examples`). Tools act on it. |
| `hinted` | Only agent-facing text carries it: the meaning survives, but nothing enforces or lowers it. These are `owl:TransitiveProperty` and `owl:SymmetricProperty` (relationship instructions), `owl:equivalentClass` and `owl:equivalentProperty` to a named term (synonyms), and `owl:deprecated` with its `rdfs:seeAlso` replacement (a description prefix and an instruction). |
| `dropped` | It is not in the model. The reason is the importer's warning when it gave one, else the mapping policy. |

Each entry names the construct by its vocabulary term, the occurrence in a form
that reads on its own, and where it landed or why it did not:

```json
[
  {"construct": "rdfs:subClassOf", "subject": "Customer SubClassOf Party",
   "outcome": "compiled", "target": "entity Customer extends"},
  {"construct": "owl:TransitiveProperty", "subject": "partOf",
   "outcome": "hinted", "target": "relationship partOf ai_context.instructions",
   "reason": "no native construct: agents are told the edge is transitive and to follow it with a bounded quantified path"},
  {"construct": "owl:propertyChainAxiom",
   "subject": "servedBy = placedBy o assignedTo", "outcome": "dropped",
   "reason": "no native construct for a property chain (a derived relationship needs its join path spelled out)"}
]
```

A chain member that is an anonymous inverse (`[ owl:inverseOf p ]`) reads
`inverse(p)`, so a subject is the same on every run.

Take an ontology with one occurrence of most constructs: a subclass, keys, a
functional datatype property, an inverse pair, a property chain, a transitive
and a symmetric property, an equivalence folded into its keyed class, a defined
class, an enumeration and a deprecated class. Its summary reads:

```console
coverage (owl import of model 'shop'):
  construct                            compiled  hinted  dropped
  owl:Class                                   8       0        0
  owl:equivalentClass (folded)                1       0        0
  rdfs:subClassOf                             2       0        0
  owl:hasKey                                  3       0        0
  owl:hasKey (absent)                         1       0        1
  owl:DatatypeProperty                        4       0        0
  rdfs:range                                  4       0        0
  owl:FunctionalProperty                      1       0        0
  owl:ObjectProperty                          6       0        0
  owl:inverseOf                               1       0        0
  owl:propertyChainAxiom                      0       0        1
  owl:TransitiveProperty                      0       1        0
  owl:SymmetricProperty                       0       1        0
  owl:equivalentClass (defined class)         1       0        0
  owl:Restriction                             1       0        0
  owl:oneOf                                   0       0        1
  rdfs:comment                                1       0        0
  skos:altLabel                               1       0        0
  owl:deprecated                              0       1        0
  rdfs:seeAlso                                0       1        0
  owl:Ontology                                1       0        0
  total                                      36       4        3
```

An outcome is a fact about the output. The report is built after the mapping,
by comparing the parsed ontology with the imported model, rather than by
repeating the mapper's decisions. Some outcomes worth knowing:

- An `owl:Restriction` compiles into a constraint, into a defined entity's
  membership predicate, or into the model structure when the model already
  guarantees it (a field holds one value; an edge ends at its declared
  destination).
- `owl:FunctionalProperty` on a datatype property compiles by construction: a
  field holds at most one value.
- An `owl:equivalentClass` definition that does not compile to a defined entity
  is dropped with the blocking reason. The class is then imported as a subclass
  whose restrictions become constraints.
- The label and comment of an inverse reading are dropped once it is folded
  into its forward relationship: the inverse is a name, not a second
  relationship.
- A named individual compiles only when a compiled definition uses its code.
  Otherwise it is dropped as instance data, like `owl:AllDifferent`.
- With [`--prune-unbound`](#5-pruning-to-what-is-bound-proposed), whatever was
  removed is dropped with the reason for the removal, whatever the mapping
  made of it:
  - `pruned (--prune-unbound): not bound, not an ancestor of a bound entity,
    and not defined over one` for an entity and what it owns (its fields, keys
    and annotations);
  - `pruned (--prune-unbound): an endpoint entity was pruned` for a
    relationship and its characteristics;
  - `pruned (--prune-unbound): an abstract relationship with no kept
    sub-relationship`;
  - `pruned (--prune-unbound): the constraint names a pruned entity` for an
    axiom whose constraint was removed while its class was kept.

The report goes to `coverage.json` beside the written model, or to
`--coverage <path>`; `--no-coverage` skips both the summary and the file. The
file format, shared with [`kcmd shacl
import`](shacl-import.md#3-coverage-report-proposed), is described in [What an
import keeps](fidelity.md#what-an-import-keeps-proposed), together with what
each compiled construct becomes in a BigQuery graph.

## Limitations

Three different situations hide in "not covered": constructs already read but not
yet resolved all the way downstream, constructs not read but reachable next, and
constructs out of scope.

**Read now — only downstream resolution is pending.** The **class hierarchy**
(`rdfs:subClassOf`) maps to entity `extends` (see [Class
hierarchies](#class-hierarchies-rdfssubclassof)); the importer handles it today
and the remaining work is downstream, not in the import:

- **BigQuery** push resolves it into node-table labels, inherited fields
  flattened down (see [Class hierarchies (`extends` →
  labels)](reference.md#class-hierarchies-extends--labels)).
- **Knowledge Catalog** records it as a `Specializes:` paragraph on each
  subtype entry, restored on pull; each entry still lists only its own fields.

**Not imported — dropped.** OWL can state things the semantic model has no native
slot for. The importer reads them but does **not** carry them (an earlier version
rode them along as `custom_extensions`; that was removed so an imported model is a
clean semantic model). To keep any of these, model them natively after import.
Dropped:

- **Datatype-property inheritance** — `rdfs:subPropertyOf` between datatype
  properties (between object properties it maps to relationship `extends`).
- **Cross-references** — `owl:propertyDisjointWith`.
  (`owl:equivalentClass` / `owl:equivalentProperty` to a named term are
  imported as synonyms — see [Semantic
  annotations](#semantic-annotations-equivalence-deprecation-transitivity);
  `owl:disjointWith` becomes a constraint; `owl:inverseOf` becomes a
  relationship `inverse` — only the inverse property's own label / comment is
  not carried, since the inverse is a name, not a second relationship.)
- **Property characteristics** — reflexive / irreflexive / asymmetric, and
  functional on a *datatype* property (functional on an object property becomes
  a constraint; transitive and symmetric become relationship query hints).
- **What vocabularies and chains leave out.** Enumerations, named
  individuals and property chains are imported (proposed; see
  [Vocabularies](#vocabularies-owloneof-named-individuals) and [Property
  chains](#property-chains-owlpropertychainaxiom)). Still dropped: an
  individual's object-property assertions and its other data values, and
  chains on a property beyond its first. Also dropped are chains a fixed join
  cannot follow: a single step, a recursive chain, or a step other than a
  named property or `owl:inverseOf`.
- **Set-level axioms** — `owl:AllDisjointProperties`, `owl:AllDifferent`
  (`owl:AllDisjointClasses` becomes a constraint).
- **Per-term annotations** — `rdfs:isDefinedBy`, `owl:versionInfo`, and
  `rdfs:seeAlso` except as a deprecation replacement. (`owl:deprecated` is
  imported as a description prefix and instruction.)

**Not read — out of scope.** Richer OWL/RDF beyond the schema-shaped subset this
converter targets:

- SHACL shapes in the ontology files (import them separately with
  [`kcmd shacl import`](shacl-import.md)), class expressions (`owl:unionOf` /
  `owl:complementOf` / `owl:oneOf`, and a restriction whose filler is itself
  anonymous), individuals (A-box instances) beyond the vocabulary members
  they supply, and `owl:sameAs` /
  `owl:differentFrom` (which relate individuals). Only **named** (IRI) classes
  and properties become entities, fields, and relationships: an anonymous class
  expression is never an entity and does not count in the import summary. The
  one class expression that IS read is `owl:intersectionOf` on a class's
  `owl:equivalentClass` / `rdfs:subClassOf` — the form Protégé emits for a
  defined class — and only its conjuncts: a restriction conjunct becomes a
  constraint and a named conjunct becomes `extends` (see
  [Intersections](#rules-restrictions-functional-properties-disjointness)). A
  union / complement conjunct inside it is dropped, as are typed
  `[ a rdfs:Datatype ; ... ]` ranges. The exception is an
  `owl:equivalentClass` definition one row of the base can decide: its whole
  expression (unions, complements, enumerations and datatype facets included)
  compiles to a defined entity, and individuals are read only for their codes
  (see [Defined classes](#defined-classes-owlequivalentclass)).
- OWL serializations other than Turtle (`.ttl`), and the reverse direction —
  semantic model → OWL export. Import is one-way.
- Remote `owl:imports`. An import is followed only to a local file (see
  [Importing a modular ontology](#importing-a-modular-ontology-several-files));
  nothing is fetched over the network, so an import with no local file is
  warned and its terms are absent.
