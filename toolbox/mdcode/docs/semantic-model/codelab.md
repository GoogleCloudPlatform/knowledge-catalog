# End-to-end codelab: one semantic model, from authoring to query

A self-contained walkthrough. You author a semantic model, govern it in Knowledge
Catalog, and bind it to physical stores — BigQuery and Spanner — to query it in
each. The model is defined once and every store reads from that single
definition. The expected output is shown after each command so you can check as
you go.

For the deploy mechanics on their own (author, push, update, pull), see the
[deploy guide](README.md); for every flag and permission, see the
[reference](reference.md).

---

## Setup

You need the `gcloud` and `bq` CLIs, and `kcmd` on your `PATH` (build it from
source: see [Build](../../README.md#build)). `kcmd` uses your `gcloud`
configuration for credentials, project, and region:

```bash
gcloud auth application-default login
gcloud config set project <your-project>
gcloud config set compute/region <your-region>
```

The commands below reuse a few names. Set them once for your own project:

```bash
export PROJECT=$(gcloud config get-value project)  # used in table and graph names
export LOCATION=global                              # Knowledge Catalog entry-group location
export DATASET=datacloud_demo                       # BigQuery dataset + KC entry group
export GRAPH=sales                                  # property-graph name
```

---

## 1. Author the logical model

`init` provisions the Knowledge Catalog entry group and a local workspace:

```bash
mkdir -p ~/semantic-model-codelab && cd ~/semantic-model-codelab
kcmd init --semantic-model $PROJECT.$LOCATION.$DATASET
# -> scope: semantic-model.$PROJECT.$LOCATION.$DATASET
```

Author the model in two parts — this is what lets one model serve many stores:

- The **logical model** (this step) declares the business: three entities
  (`orders`, `customer`, `lineitem`), the relationships between them, and one
  metric (`revenue`). It names nothing physical.
- A **binding profile** then says where each entity reads from and which column
  each field is. You write one when you deploy to BigQuery (step 3) and another
  for Spanner (step 4); the logical model never changes.

### Author by hand

Write the logical model — declarations only, no sources, no columns, no
deployment target:

```bash
cat > catalog/EntryGroups/$DATASET/sales.yaml <<'YAML'
version: "0.2.0.dev0"
semantic_model:
  - name: sales
    description: Orders, line items, and customers for the codelab
    entities:
      - name: orders
        primary_key: [o_orderkey]
        fields:
          - { name: o_orderkey, datatype: Integer }
          - { name: o_custkey,  datatype: Integer }
          - { name: net_amount, datatype: Decimal }
      - name: customer
        primary_key: [c_custkey]
        fields:
          - { name: c_custkey, datatype: Integer }
          - { name: c_name,    datatype: String }
      - name: lineitem
        primary_key: [l_linekey]
        fields:
          - { name: l_linekey,  datatype: Integer }
          - { name: l_orderkey, datatype: Integer }
    relationships:
      - name: orders_to_customer
        from: orders
        to: customer
        from_columns: [o_custkey]
        to_columns: [c_custkey]
      - name: lineitem_to_orders
        from: lineitem
        to: orders
        from_columns: [l_orderkey]
        to_columns: [o_orderkey]
    metrics:
      - name: revenue
        datatype: Decimal
        expression:
          dialects: [{ dialect: BIGQUERY, expression: SUM(orders.net_amount) }]
YAML
```

### Import from an OWL ontology

You can also start from an existing OWL ontology instead of hand-authoring this
YAML. `kcmd owl import` converts an ontology (`.ttl`) into a semantic model:
classes become entities, datatype properties become fields, and object
properties become relationships. Write a tiny ontology and import it:

```bash
cat > /tmp/parts.ttl <<'TTL'
@prefix owl:  <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
@prefix ex:   <http://example.com/commerce#> .

ex:Part a owl:Class ;
    rdfs:label "Part" ;
    rdfs:comment "A sellable part" .
ex:Supplier a owl:Class ;
    rdfs:label "Supplier" .

ex:partName a owl:DatatypeProperty ;
    rdfs:domain ex:Part ;
    rdfs:range xsd:string .
ex:partPrice a owl:DatatypeProperty ;
    rdfs:domain ex:Part ;
    rdfs:range xsd:decimal .
ex:suppliedBy a owl:ObjectProperty ;
    rdfs:domain ex:Part ;
    rdfs:range ex:Supplier .
TTL

kcmd owl import /tmp/parts.ttl --out /tmp/parts_osi.yaml
```

```
converted 2 classes, 1 object property, 2 datatype properties
wrote /tmp/parts_osi.yaml
note: this model is UNBOUND (placeholder `unbound:` sources, no deployment target).
      `kcmd push` is rejected until you bind each entity's source table and add
      a BigQuery deployment target -- validation needs both, for every --target.
```

Look at what it produced:

```bash
cat /tmp/parts_osi.yaml
```

```yaml
version: 0.2.0.dev0
semantic_model:
  - name: parts
    description: Imported from OWL ontology http://example.com/commerce#
    datasets:
      - name: Part
        source: unbound:Part
        description: A sellable part
        fields:
          - name: partName
            expression:
              dialects:
                - dialect: BIGQUERY
                  expression: partName
            datatype: String
          - name: partPrice
            expression:
              dialects:
                - dialect: BIGQUERY
                  expression: partPrice
            datatype: Decimal
      - name: Supplier
        source: unbound:Supplier
    relationships:
      - name: suppliedBy
        from: Part
        to: Supplier
        from_columns:
          - TODO_BIND
        to_columns:
          - TODO_BIND
```

The classes became `Part` and `Supplier` entities, the datatype properties
became `Part`'s fields, and the object property became the `suppliedBy`
relationship. (The importer writes them under `datasets:`, the original spelling
of the `entities:` key this codelab uses — the two are interchangeable.) The
`source: unbound:*` and `TODO_BIND` join columns are
placeholders: the import gives you structure, and you bind it to physical tables
and a deployment target before deploying to a query engine — which is exactly
what the `analytical` binding adds to the hand-authored `sales` model in step 3.
For the full OWL mapping — class hierarchies, unique keys, and the constructs
carried as custom extensions — see [Importing an OWL ontology](owl-import.md).

The rest of this codelab uses the hand-authored `sales` model above.

---

## 2. Govern it in Knowledge Catalog

You can govern the model right now — the push writes the logical model straight
to the catalog as entries, so there is nothing to bind or load first.

### Preview the plan

Preview the plan without writing anything:

```bash
kcmd push --target kc --validate-only --print
```

```
Validating semantic model for Knowledge Catalog...
Warning: [sales] relationship 'orders_to_customer': Knowledge Catalog stores the name only in the normalized link id, so a pull returns it lowercased/hyphenated (e.g. 'orders-to-customer'), not 'orders_to_customer'.
Warning: [sales] relationship 'lineitem_to_orders': Knowledge Catalog stores the name only in the normalized link id, so a pull returns it lowercased/hyphenated (e.g. 'lineitem-to-orders'), not 'lineitem_to_orders'.
-- Knowledge Catalog --
Knowledge Catalog plan for 'sales' (destination $PROJECT.$LOCATION.$DATASET):
  5 entries:
    - sales (semantic-model)
    - sales.entities.orders (semantic-entity)
    - sales.entities.customer (semantic-entity)
    - sales.entities.lineitem (semantic-entity)
    - sales.metrics.revenue (semantic-metric)
  2 schema-join links:
    - sales-orders-to-customer
    - sales-lineitem-to-orders
Validation complete; no changes applied.
```

The two warnings are informational, and every Knowledge Catalog push repeats
them: relationship names come back from a `kcmd pull` lowercased and hyphenated
(`orders-to-customer`), because Knowledge Catalog keeps the name only in the
normalized link id. Nothing is wrong — the graph itself keeps the authored
`orders_to_customer`.

### Write the entries

Then drop `--validate-only` to perform the write:

```bash
kcmd push --target kc
```

```
Pushing semantic model (Knowledge Catalog)...
Wrote 5 new and 0 updated Knowledge Catalog entries; linked 2 relationships.
```

Each entity, the metric,
and the model itself are now governed entries, joined by a schema-join link —
discoverable, access-controlled, and the single definition every downstream step
reads from. `kcmd pull` reconstructs the model YAML from these entries, confirming
the round-trip. You develop the model, govern it here, and bind it in the sections
that follow — and those physical bindings can be governed in Knowledge Catalog
too.

> This write needs the `semantic-model` / `semantic-entity` / `semantic-metric`
> entry types and write access to the entry group. See
> [Permissions](reference.md#permissions).

---

## 3. Deploy to BigQuery and get reliable insights

Governing the model created catalog entries but no tables. Deploying it to a
query engine creates the tables and the graph. You add a **binding profile**,
create the data, and deploy.

### Write the binding profile

Write the **analytical** binding: the BigQuery table each entity reads, the
column each field maps to, and the BigQuery graph to deploy to. The
`deployment_target` key names that graph. A binding lives beside the model in
`sales.profiles/`:

```bash
# BigQuery deployment target, named by the profile's deployment_target key.
BQ_DS=projects/$PROJECT/datasets/$DATASET
TARGET=//bigquery.googleapis.com/$BQ_DS/propertyGraphs/$GRAPH

mkdir -p catalog/EntryGroups/$DATASET/sales.profiles
cat > catalog/EntryGroups/$DATASET/sales.profiles/analytical.yaml <<YAML
version: "0.2.0.dev0"
semantic_model:
  - name: sales
    deployment_target: $TARGET
    entities:
      - name: orders
        source: $PROJECT.$DATASET.orders
        fields:
          - { name: o_orderkey, expression: o_orderkey }
          - { name: o_custkey,  expression: o_custkey }
          - { name: net_amount, expression: net_amount }
      - name: customer
        source: $PROJECT.$DATASET.customer
        fields:
          - { name: c_custkey, expression: c_custkey }
          - { name: c_name,    expression: c_name }
      - name: lineitem
        source: $PROJECT.$DATASET.lineitem
        fields:
          - { name: l_linekey,  expression: l_linekey }
          - { name: l_orderkey, expression: l_orderkey }
YAML
```

The binding restates no relationship, no metric, and no grain — those are logical
and live once in the model. It carries only bindings: each entity's table and
each field's column. Make it the default so a bare `kcmd push` selects it (the
rest of this step relies on this); step 4 selects the other profile explicitly
with `--profile`:

```bash
echo 'default_profile: analytical' >> catalog.yaml
```

> **Simple case — one binding, one file.** If a model only ever binds to one
> store, you do not need a separate profile. Put the `deployment_target`, each
> entity's `source`, and each field's `expression` directly on the model in
> `sales.yaml` — that is the `default` profile — and run a bare `kcmd push`. An
> `orders` entity then reads:
>
> ```yaml
> semantic_model:
>   - name: sales
>     deployment_target: //bigquery.googleapis.com/.../propertyGraphs/sales
>     entities:
>       - name: orders
>         source: $PROJECT.$DATASET.orders
>         primary_key: [o_orderkey]
>         fields:
>           - { name: o_orderkey, datatype: Integer, expression: o_orderkey }
>           # ...
> ```
>
> This codelab splits them because step 4 adds a second store, and that split is
> what lets one model back both.

### Create the tables

Now create the data. An ontology-driven data-engineering agent would produce it
from raw sources; for a self-contained run, create the three tables directly.
`net_amount` is materialized on `orders` (the measure aggregates it), and each
order fans out into several `lineitem` rows:

```bash
bq mk -f --dataset $PROJECT:$DATASET

bq query --use_legacy_sql=false '
CREATE OR REPLACE TABLE `'"$PROJECT.$DATASET"'.customer` AS
SELECT * FROM UNNEST([STRUCT(1 AS c_custkey, "Acme" AS c_name),
                      STRUCT(2, "Globex")]);
CREATE OR REPLACE TABLE `'"$PROJECT.$DATASET"'.orders` AS
SELECT * FROM UNNEST([
  STRUCT(100 AS o_orderkey, 1 AS o_custkey,  90.0 AS net_amount),
  STRUCT(101, 1, 200.0),
  STRUCT(102, 2,  40.0)
]);
CREATE OR REPLACE TABLE `'"$PROJECT.$DATASET"'.lineitem` AS
SELECT * FROM UNNEST([                 -- order 100: 2 lines, 101: 1, 102: 3
  STRUCT(1 AS l_linekey, 100 AS l_orderkey), STRUCT(2, 100),
  STRUCT(3, 101),
  STRUCT(4, 102), STRUCT(5, 102), STRUCT(6, 102)
]);'
```

> **Why the tables come before the BigQuery push.** Unlike the Knowledge Catalog
> step, `kcmd push --target bq` validates that every entity's `source` table
> resolves in BigQuery — even under `--validate-only` — and builds the graph over
> these tables. So the tables must exist first. (Step 2 needed none of this: it
> governed the logical model, no tables required.)

### Deploy the graph

Now deploy the bound model to BigQuery. `--print` shows the generated DDL:

```bash
kcmd push --target bq --print
```

The generated graph turns each entity into a node table, each relationship into an
edge, and the metric into a measure (your `$PROJECT`/`$DATASET` appear in the fully
qualified names):

```sql
Pushing semantic model (BigQuery Graph)...
-- BigQuery Graph --
-- //bigquery.googleapis.com/projects/$PROJECT/datasets/$DATASET/propertyGraphs/$GRAPH
CREATE OR REPLACE PROPERTY GRAPH `$PROJECT.$DATASET.$GRAPH`
NODE TABLES (
  `$PROJECT.$DATASET.orders` AS orders
    KEY(o_orderkey)
    PROPERTIES(
      o_orderkey,
      o_custkey,
      net_amount,
      MEASURE(SUM(net_amount)) AS revenue
    ),
  `$PROJECT.$DATASET.customer` AS customer
    KEY(c_custkey)
    PROPERTIES(
      c_custkey,
      c_name
    ),
  `$PROJECT.$DATASET.lineitem` AS lineitem
    KEY(l_linekey)
    PROPERTIES(
      l_linekey,
      l_orderkey
    )
)
EDGE TABLES (
  `$PROJECT.$DATASET.orders` AS orders_to_customer
    KEY(o_orderkey)
    SOURCE KEY(o_orderkey) REFERENCES orders(o_orderkey)
    DESTINATION KEY(o_custkey) REFERENCES customer(c_custkey),
  `$PROJECT.$DATASET.lineitem` AS lineitem_to_orders
    KEY(l_linekey)
    SOURCE KEY(l_linekey) REFERENCES lineitem(l_linekey)
    DESTINATION KEY(l_orderkey) REFERENCES orders(o_orderkey)
);

Deployed 1 BigQuery Graph(s).
```

### View the graph in the console

The graph is now a resource in your dataset, and the console draws its schema as
a diagram of node and edge tables — easier to read than the DDL above. Print the
BigQuery Studio link to the dataset:

```bash
# printf with a single-quoted format string: the `!` are literal, not bash history expansion.
printf 'https://console.cloud.google.com/bigquery?project=%s&ws=!1m4!1m3!3m2!1s%s!2s%s\n' "$PROJECT" "$PROJECT" "$DATASET"
```

Open the link, expand the `$DATASET` dataset in the Explorer, and click the
`$GRAPH` property graph. Its schema renders as a visual graph of the nodes and
the edges that connect them.

### Query the graph two ways

Now ask the same question — revenue by customer — two ways.

**Before** — hand-written SQL. An analyst who wants revenue "with the line-item
detail" writes the obvious join across all three tables:

```bash
bq query --use_legacy_sql=false --nouse_cache '
SELECT c.c_name, SUM(o.net_amount) AS revenue
FROM `'"$PROJECT.$DATASET"'.customer` c
JOIN `'"$PROJECT.$DATASET"'.orders` o    ON o.o_custkey  = c.c_custkey
JOIN `'"$PROJECT.$DATASET"'.lineitem` li ON li.l_orderkey = o.o_orderkey
GROUP BY c.c_name ORDER BY c.c_name'
```

The result is **wrong**. Joining in `lineitem` repeats each order's `net_amount`
once per line, so revenue is inflated by the line count — Acme's `90 + 200` becomes
`90×2 + 200×1 = 380`, Globex's `40` becomes `40×3 = 120`:

```
+--------+---------+
| c_name | revenue |
+--------+---------+
| Acme   |   380.0 |   <- should be 290
| Globex |   120.0 |   <- should be 40
+--------+---------+
```

Nothing errors. The query succeeds and returns a total that is too large. This is
the fan-out trap: any consumer that writes its own join can hit it.

**After** — through the model's `revenue` measure. A measure is a *symmetric
aggregate*: it sums each order once however the graph is traversed, so the
fan-out cannot double-count. You read it by flattening the graph with
`GRAPH_EXPAND` and wrapping the measure in `AGG()`, with columns named
`<node>_<field>`. The query names no table, no join, and no formula:

```bash
bq query --use_legacy_sql=false --nouse_cache '
SELECT customer_c_name AS c_name, AGG(orders_revenue) AS revenue
FROM GRAPH_EXPAND("'"$PROJECT.$DATASET.$GRAPH"'")
GROUP BY c_name ORDER BY c_name'
```

This one is **right**:

```
+--------+---------+
| c_name | revenue |
+--------+---------+
| Acme   |   290.0 |
| Globex |    40.0 |
+--------+---------+
```

Same question, same data: the hand-written join inflates the total, the measure
returns the correct one. `revenue` is now an enforced, queryable concept. The
join and the formula come from the model rather than from whoever writes the
query, so the correct answer is the default one.

> **Tips.** Use `--nouse_cache` — `GRAPH_EXPAND` result caches are not
> invalidated by graph edits. To see the exact output column names for a graph:
> `DECLARE s STRING; CALL BQ.SHOW_GRAPH_EXPAND_SCHEMA("$PROJECT.$DATASET.$GRAPH", s); SELECT s;`

---

## 4. Deploy the same model to Spanner

The same customers and orders usually live in more than one store. Step 3 bound
and deployed the `analytical` profile — the BigQuery warehouse. An operational
Spanner database holds the same business, but its tables are named differently
(`Customers`, `Orders`, `LineItems`), its columns are named differently
(`FullName`, `OrderId`), and it does not carry `net_amount` — a settled figure
the warehouse computes rather than one the live store keeps.

### Write the operational binding

Add a **second profile** beside the first. Like the `analytical` one, it changes
only where each entity reads from and which column each field binds to; it never
changes what an entity, a relationship, or a metric *means* (for the full
contract, see [binding profiles](profiles.md)). Write the operational binding
into the same `sales.profiles/` directory:

```bash
export SPANNER_INSTANCE=<your-spanner-instance>   # a Spanner ENTERPRISE-edition instance
export SPANNER_DB=<your-googlesql-database>
SPANNER_TARGET=//spanner.googleapis.com/projects/$PROJECT/instances/$SPANNER_INSTANCE/databases/$SPANNER_DB/propertyGraphs/$GRAPH

mkdir -p catalog/EntryGroups/$DATASET/sales.profiles
cat > catalog/EntryGroups/$DATASET/sales.profiles/operational.yaml <<YAML
version: "0.2.0.dev0"
semantic_model:
  - name: sales
    deployment_target: $SPANNER_TARGET
    entities:
      - name: orders
        source: Orders                       # a bare table in the Spanner database
        fields:
          - { name: o_orderkey, expression: OrderId }
          - { name: o_custkey,  expression: CustomerId }
          - { name: net_amount, unbound: true }   # the operational store has no settled total
      - name: customer
        source: Customers
        fields:
          - { name: c_custkey, expression: CustomerId }
          - { name: c_name,    expression: FullName }
      - name: lineitem
        source: LineItems
        fields:
          - { name: l_linekey,  expression: LineId }
          - { name: l_orderkey, expression: OrderId }
YAML
```

The profile restates no relationship, no metric, no label, and no grain — those
are logical and live once in the model. It carries only bindings: each entity's
Spanner table, each field's Spanner column, and the one field the store does not
have. `kcmd profiles` reports what each binding can answer:

```bash
kcmd profiles
```

```
Model 'sales' ($DATASET):
  profile 'analytical' (default)
    target: //bigquery.googleapis.com/projects/$PROJECT/datasets/$DATASET/propertyGraphs/sales
    sources:
      orders -> $PROJECT.$DATASET.orders
      customer -> $PROJECT.$DATASET.customer
      lineitem -> $PROJECT.$DATASET.lineitem
    cannot answer: nothing withheld.
  profile 'operational'
    target: //spanner.googleapis.com/projects/$PROJECT/instances/$SPANNER_INSTANCE/databases/$SPANNER_DB/propertyGraphs/sales
    sources:
      orders -> $PROJECT.Orders
      customer -> $PROJECT.Customers
      lineitem -> $PROJECT.LineItems
    cannot answer:
      field orders.net_amount (unbound)
      metric revenue (field orders.net_amount is unbound)
```

Both profiles now show side by side: `analytical` binds every field, so it
withholds nothing; `operational` leaves `net_amount` unbound. (`kcmd profiles`
resolves each source against your project for display — the `analytical` sources
are fully qualified, and each `operational` bare table such as `Orders` is shown
project-prefixed; the Spanner graph itself references the bare `Orders`, as the
DDL below shows.)

`revenue` is `SUM(orders.net_amount)`, and the operational store does not bind
`net_amount`, so the profile reports `revenue` as unavailable there — computed
from the bindings rather than declared. The `analytical` profile binds `net_amount`, so
the same metric is available under the binding step 3 used. One model; each store
answers the part of it that its data can back.

### Preview the generated DDL

Preview the Spanner DDL the profile generates (`--validate-only` runs the
generator without touching a database):

```bash
kcmd push --profile operational --target spanner --validate-only --print
```

```
Note: profile 'operational' leaves 1 field(s) unbound; 0 entity(ies), 1 metric(s) and 0 relationship(s) unavailable.
Validating semantic model for Spanner Graph...
-- Spanner Graph --
-- //spanner.googleapis.com/projects/$PROJECT/instances/$SPANNER_INSTANCE/databases/$SPANNER_DB/propertyGraphs/sales
CREATE OR REPLACE PROPERTY GRAPH sales
NODE TABLES (
  Orders AS orders
    KEY(OrderId)
    PROPERTIES(
      OrderId AS o_orderkey,
      CustomerId AS o_custkey
    ),
  Customers AS customer
    KEY(CustomerId)
    PROPERTIES(
      CustomerId AS c_custkey,
      FullName AS c_name
    ),
  LineItems AS lineitem
    KEY(LineId)
    PROPERTIES(
      LineId AS l_linekey,
      OrderId AS l_orderkey
    )
)
EDGE TABLES (
  Orders AS orders_to_customer
    KEY(OrderId)
    SOURCE KEY(OrderId) REFERENCES orders(OrderId)
    DESTINATION KEY(CustomerId) REFERENCES customer(CustomerId),
  LineItems AS lineitem_to_orders
    KEY(LineId)
    SOURCE KEY(LineId) REFERENCES lineitem(LineId)
    DESTINATION KEY(OrderId) REFERENCES orders(OrderId)
);

Validation complete; no changes applied.
```

The graph still speaks the model's vocabulary — the properties are `o_orderkey`,
`c_name`, and the rest — but each is now backed by the profile's Spanner column
(`OrderId AS o_orderkey`, `FullName AS c_name`). The key and reference clauses
name the physical columns (`KEY(OrderId)`), because a Spanner graph keys on the
table's real column rather than the property alias. Three things also differ from the
BigQuery DDL in step 3:

- **Bare table and graph names.** A Spanner property graph names tables inside
  one database, so there is no backticked `project.dataset.` qualifier — each
  `source` is a bare table (`Orders`) in the target database.
- **No `MEASURE`.** Spanner Graph has no measures. `revenue` is already withheld
  here because `net_amount` is unbound, but even a bound metric is not emitted
  onto a Spanner node; author metrics as usual and a BigQuery target still emits
  them.
- **No `OPTIONS`.** Descriptions and synonyms are not written into the Spanner
  DDL; they live in Knowledge Catalog instead.

### Create the tables and deploy

To apply it for real, create the operational tables in a Spanner
ENTERPRISE-edition database (Graph requires ENTERPRISE), load a little data, and
drop `--validate-only`. The Spanner leg applies the DDL through the
`updateDatabaseDdl` long-running operation and does not create or pre-check the
tables, so they must exist first:

```bash
gcloud spanner databases create $SPANNER_DB --instance=$SPANNER_INSTANCE \
  --ddl='CREATE TABLE Customers (CustomerId INT64 NOT NULL, FullName STRING(MAX)) PRIMARY KEY(CustomerId)' \
  --ddl='CREATE TABLE Orders (OrderId INT64 NOT NULL, CustomerId INT64) PRIMARY KEY(OrderId)' \
  --ddl='CREATE TABLE LineItems (LineId INT64 NOT NULL, OrderId INT64) PRIMARY KEY(LineId)'

gcloud spanner databases execute-sql $SPANNER_DB --instance=$SPANNER_INSTANCE \
  --sql="INSERT INTO Customers (CustomerId, FullName) VALUES (1,'Acme'),(2,'Globex')"
gcloud spanner databases execute-sql $SPANNER_DB --instance=$SPANNER_INSTANCE \
  --sql="INSERT INTO Orders (OrderId, CustomerId) VALUES (100,1),(101,1),(102,2)"
gcloud spanner databases execute-sql $SPANNER_DB --instance=$SPANNER_INSTANCE \
  --sql="INSERT INTO LineItems (LineId, OrderId) VALUES (1,100),(2,100),(3,101),(4,102),(5,102),(6,102)"

kcmd push --profile operational --target spanner
# -> Deployed 1 Spanner Graph(s).
```

> **Knowledge Catalog is unchanged.** You do not re-push to Knowledge Catalog for
> the Spanner leg. Step 2 governed the *logical* model, and adding a binding
> profile changes nothing logical — bindings are not governed in Knowledge
> Catalog. The single set of entries from step 2 already describes this graph too.

### Query the graph

Query it with Spanner's Graph Query Language. The query names the model's
properties (`c_name`, `o_orderkey`); the profile's column bindings are invisible
to it:

```bash
gcloud spanner databases execute-sql $SPANNER_DB --instance=$SPANNER_INSTANCE \
  --sql="GRAPH sales MATCH (o:orders)-[:orders_to_customer]->(c:customer)
         RETURN c.c_name AS customer, COUNT(o.o_orderkey) AS orders
         GROUP BY customer ORDER BY customer"
```

```
customer  orders
Acme      2
Globex    1
```

The one model now backs two stores: the BigQuery warehouse from step 3, where
`revenue` is a measure, and this operational Spanner graph, where the same
entities and relationships are queried live and `revenue` is computed in SQL or
the application rather than by the graph. `Customer`, `orders_to_customer`, and
every field mean the same thing in both; only the bindings differ.

---

## 5. Clean up

Drop the BigQuery dataset (tables + property graph):

```bash
bq rm -r -f -d $PROJECT:$DATASET
```

Drop the Spanner database from step 4 (its tables and the graph go with it):

```bash
gcloud spanner databases delete $SPANNER_DB --instance=$SPANNER_INSTANCE --quiet
```

Remove the Knowledge Catalog entries and entry group via REST:

```bash
TOKEN=$(gcloud auth application-default print-access-token)
EG=projects/$PROJECT/locations/$LOCATION/entryGroups/$DATASET

for E in sales sales.entities.orders sales.entities.customer sales.entities.lineitem sales.metrics.revenue; do
  curl -s -X DELETE -H "Authorization: Bearer $TOKEN" \
    "https://dataplex.googleapis.com/v1/$EG/entries/$E" >/dev/null
done
curl -s -X DELETE -H "Authorization: Bearer $TOKEN" "https://dataplex.googleapis.com/v1/$EG"
```

Remove the local workspace that step 1 created:

```bash
rm -rf ~/semantic-model-codelab
```
