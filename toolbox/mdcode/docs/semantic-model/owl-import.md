# Importing an OWL ontology

An OWL ontology and a semantic model share a backbone: **classes ≈ entities**,
**object properties ≈ relationships**, **datatype properties ≈ fields**. `kcmd`
does not learn a second format — it **converts OWL into a semantic model** once,
then the ontology rides the normal [`kcmd push` / `kcmd pull`](README.md)
workflow. The semantic model stays the single canonical form.

The converter maps the OWL constructs that have a clean BigQuery Graph shape to
**native** semantic-model fields — class → node, object property → edge,
datatype property → property, plus **class hierarchies** (`rdfs:subClassOf` →
entity `extends`, see [Class hierarchies](#class-hierarchies-rdfssubclassof)).
Import is **one-way and lossy by design**: constructs with no native
semantic-model home — property inheritance (`rdfs:subPropertyOf`), the inverse /
equivalence / disjointness cross-references, the property characteristics, the
set-level axioms, and per-term annotations (`rdfs:seeAlso`, `owl:deprecated`, …)
— are **not imported**. The result is a clean semantic model, never an OWL
document wrapped in opaque metadata. What maps and what drops is listed in [How
each OWL construct maps](#how-each-owl-construct-maps) and
[Limitations](#limitations).

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
```

The model name comes from the file (`sales.owl.ttl` → `sales`). By default the
document is written into the semantic-model layout dir so the next `kcmd push`
picks it up; pass `--out <path>` to write it elsewhere. The output uses the
block layout shown below; pass `--compact` for the compact flow layout
(`primary_key: [id]`, inline `{ name, datatype }` field and relationship maps)
instead. Either way it is a purely **logical** model — `kcmd push` publishes it
to Knowledge Catalog as-is, while a BigQuery or Spanner Graph deploy needs each
relationship's join columns added to the model plus a [binding
profile](profiles.md) (see [§4](#4-going-from-ontology-to-a-running-graph-binding)).

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
| `owl:DatatypeProperty` | `fields[]` on **each** domain's dataset | a property with several `rdfs:domain` values lands on each; a logical field — **no `expression`** (a binding profile maps it to a column) |
| `owl:ObjectProperty` | `relationships[]` | `from` = domain, `to` = range; a **logical edge with no join columns** (you add `from_columns`/`to_columns` to the model before a graph deploy, see [binding](#4-going-from-ontology-to-a-running-graph-binding)); with several `rdfs:domain`/`rdfs:range` values only the first of each is kept (a relationship is one source → one destination) and the rest are warned |
| `rdfs:subClassOf` (named superclass) | dataset `extends[]` | **entity-level inheritance only** — records the parent(s) in document order; not read on object properties (see [Class hierarchies](#class-hierarchies-rdfssubclassof)) |
| `rdfs:subPropertyOf`, `owl:inverseOf`, `owl:equivalentClass`, `owl:disjointWith`, `owl:oneOf`, `owl:equivalentProperty`, `owl:propertyDisjointWith`, `owl:propertyChainAxiom`, `owl:AllDisjointClasses`, `owl:AllDisjointProperties`, `owl:AllDifferent`, the property characteristics, `rdfs:seeAlso`, `rdfs:isDefinedBy`, `owl:deprecated`, `owl:versionInfo` | *(dropped)* | **no native home** — not imported (see [Limitations](#limitations)) |
| `rdfs:range xsd:*` | field `datatype` | see [Datatypes](#datatypes-rdfsrange) |
| `owl:hasKey ( ... )` | dataset `primary_key` | single or composite, in list order |
| `owl:InverseFunctionalProperty` | dataset `unique_keys` | a uniquely-identifying property; omitted when it is already the `primary_key`; a lone one on a keyless class is promoted to `primary_key` instead |
| `rdfs:label` on a datatype property | field `label` | the field's display name (a `label` slot exists only on fields); dropped when it only respaces/recases the name |
| `rdfs:label` on a class / object property | `ai_context.synonyms` | no `label` slot there, so a distinct label becomes an alternate name; dropped when redundant with the name |
| extra `rdfs:label` / `skos:altLabel` / `prefLabel` / `hiddenLabel` | `ai_context.synonyms` | genuinely alternate names; feed NL search |
| `skos:example` | `ai_context.examples` | sample questions / values |
| `rdfs:comment`, `skos:definition`, `dcterms:`/`dc:description` | `description` | first present wins, in that order; on an object property (which has no `description` slot) the comment rides in `ai_context.instructions` |
| term IRIs, `@prefix` | dropped (base IRI named in `description` **only when the header has no comment of its own**) | a term's identity is its local name; the source namespace is not otherwise carried |

A datatype property whose domain is not a class, or an object property missing an
endpoint, cannot be placed; it is **skipped with a warning** rather than failing
the whole import. An object property that declares *more than one* `rdfs:domain`
or `rdfs:range` is kept — a relationship maps one source to one destination, so
the first of each is used and the extra endpoints are dropped with a warning
(unlike a multi-domain *datatype* property, which lands on every domain).

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
  keys, or a composite one) are left without a `primary_key`.

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
  # Person is its own entity:
  - name: Person
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
order). A `subClassOf` whose object is a blank-node axiom (`owl:Restriction` and
similar) is not a named class, so it is ignored, as are the implicit universal
superclasses `owl:Thing` / `rdfs:Resource` (every class subclasses them, so they
carry no inheritance information).

Two boundaries to be clear about:

- **The import *records* the hierarchy; the BigQuery push *resolves* it.** The
  importer writes `Customer` with `extends: [Person]` and **only its own fields**.
  A **BigQuery** push then resolves that inheritance: it emits a `LABEL Person`
  clause on the `Customer` node table and flattens `Person`'s fields down (fields
  flow down; edges do not) — see [Class hierarchies (`extends` →
  labels)](reference.md#class-hierarchies-extends--labels). The **Knowledge Catalog** push is
  unchanged: it still publishes each entry with exactly the fields it declares
  (KC-side inheritance is a separate, later opt-in).
- **Native inheritance is entity-level only.** `extends` lives on `entities`,
  never on relationships — the boundary is structural. `rdfs:subPropertyOf`
  (property / relationship inheritance) has no such native slot, so it is **not
  imported** (see [Limitations](#limitations)).

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

With the join columns in the model and the profile in place, a single push
deploys the graph:

```console
$ kcmd push --profile warehouse   # merges the binding, then CREATE OR REPLACE PROPERTY GRAPH + KC entries
```

See [One logical model, many physical bindings](profiles.md) for the full profile
contract — what a profile may and may not set, how merge and prune work, and how
one logical model binds to several stores.

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
- **Knowledge Catalog** is the follow-on — KC push still publishes each entry
  with only its own fields.

**Not imported — dropped.** OWL can state things the semantic model has no native
slot for. The importer reads them but does **not** carry them (an earlier version
rode them along as `custom_extensions`; that was removed so an imported model is a
clean semantic model). To keep any of these, model them natively after import.
Dropped:

- **Property inheritance** — `rdfs:subPropertyOf`.
- **Cross-references** — `owl:inverseOf`, `owl:equivalentClass`,
  `owl:disjointWith`, `owl:equivalentProperty`, `owl:propertyDisjointWith`.
- **Property characteristics** — symmetric / transitive / functional /
  reflexive / irreflexive / asymmetric.
- **Enumerations** (`owl:oneOf`) and **property chains**
  (`owl:propertyChainAxiom`).
- **Set-level axioms** — `owl:AllDisjointClasses`, `owl:AllDisjointProperties`,
  `owl:AllDifferent`.
- **Per-term annotations** — `rdfs:seeAlso`, `rdfs:isDefinedBy`,
  `owl:deprecated`, `owl:versionInfo`.

**Not read yet.** Cardinality (`owl:minCardinality` / `owl:maxCardinality`)
lives on an anonymous `owl:Restriction` reached through `rdfs:subClassOf` — the
last blank-node shape the converter does not yet read. Reading it needs an
`owl:Restriction` reader joined back to its class.

**Not read — out of scope.** Richer OWL/RDF beyond the schema-shaped subset this
converter targets:

- SHACL shapes, class expressions (`owl:unionOf` / `intersectionOf`, and any
  blank-node `owl:equivalentClass` / `rdfs:subClassOf`), individuals (A-box
  instances), and `owl:sameAs` / `owl:differentFrom` (which relate individuals).
- OWL serializations other than Turtle (`.ttl`), and the reverse direction —
  semantic model → OWL export. Import is one-way.
