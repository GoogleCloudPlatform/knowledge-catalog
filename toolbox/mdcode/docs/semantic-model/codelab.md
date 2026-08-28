# End-to-end codelab: one semantic model, from authoring to query

A self-contained walkthrough. You author one semantic model, govern it in
Knowledge Catalog, hydrate its data, and query a metric through BigQuery Graph.
The metric is defined once and computed the same way at every step. The expected
output is shown after each command so you can check as you go.

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

The Knowledge Catalog step (step 3) writes the `semantic-model` /
`semantic-entity` / `semantic-metric` entry types. These are not yet generally
available on production Dataplex, so point `kcmd` at the staging (autopush)
instance where they already exist. Once the types reach GA, delete this block —
`kcmd` then defaults to production and every other command stays the same:

```bash
# Staging (autopush) EAP -- only needed until the semantic-* types are GA on prod.
export DATAPLEX_ENDPOINT=https://autopush-dataplex.sandbox.googleapis.com  # Knowledge Catalog API host
export KC_TYPE_PROJECT=dataplex-autopush-types                             # project the semantic-* types live in
```

---

## 1. Author the semantic model

`init` provisions the Knowledge Catalog entry group and a local workspace:

```bash
mkdir -p ~/datacloud-codelab && cd ~/datacloud-codelab
kcmd init --semantic-model $PROJECT.$LOCATION.$DATASET
# -> scope: semantic-model.$PROJECT.$LOCATION.$DATASET
```

Author the model: three entities (`orders`, `customer`, `lineitem`), the
relationships between them, and one metric (`revenue`). A real sales schema fans
each order out into many line-item rows, so the model includes `lineitem`. Step
4 uses that fan-out to show where hand-written SQL goes wrong. The `GOOGLE`
extension names the BigQuery Graph deployment target.

```bash
cat > catalog/EntryGroups/$DATASET/sales.yaml <<YAML
version: "0.2.0.dev0"
semantic_model:
  - name: sales
    description: Orders, line items, and customers for the codelab
    custom_extensions:
      - vendor_name: GOOGLE
        data: '{"deploymentTargets": ["//bigquery.googleapis.com/projects/$PROJECT/datasets/$DATASET/propertyGraphs/$GRAPH"]}'
    datasets:
      - name: orders
        source: $PROJECT.$DATASET.orders
        primary_key: [o_orderkey]
        fields:
          - { name: o_orderkey, datatype: Integer, expression: { dialects: [{ dialect: BIGQUERY, expression: o_orderkey }] } }
          - { name: o_custkey,  datatype: Integer, expression: { dialects: [{ dialect: BIGQUERY, expression: o_custkey }] } }
          - { name: net_amount, datatype: Decimal, expression: { dialects: [{ dialect: BIGQUERY, expression: net_amount }] } }
      - name: customer
        source: $PROJECT.$DATASET.customer
        primary_key: [c_custkey]
        fields:
          - { name: c_custkey, datatype: Integer, expression: { dialects: [{ dialect: BIGQUERY, expression: c_custkey }] } }
          - { name: c_name,    datatype: String,  expression: { dialects: [{ dialect: BIGQUERY, expression: c_name }] } }
      - name: lineitem
        source: $PROJECT.$DATASET.lineitem
        primary_key: [l_linekey]
        fields:
          - { name: l_linekey,  datatype: Integer, expression: { dialects: [{ dialect: BIGQUERY, expression: l_linekey }] } }
          - { name: l_orderkey, datatype: Integer, expression: { dialects: [{ dialect: BIGQUERY, expression: l_orderkey }] } }
    relationships:
      - { name: orders_to_customer, from: orders, to: customer, from_columns: [o_custkey], to_columns: [c_custkey] }
      - { name: lineitem_to_orders, from: lineitem, to: orders, from_columns: [l_orderkey], to_columns: [o_orderkey] }
    metrics:
      - name: revenue
        datatype: Decimal
        expression: { dialects: [{ dialect: BIGQUERY, expression: SUM(orders.net_amount) }] }
YAML
```

> **Metric constraint.** A BigQuery Graph measure can only aggregate a
> **single column** — `SUM(orders.net_amount)` is fine, but
> `SUM(o_extendedprice * (1 - o_discount))` is rejected at deploy. Any arithmetic
> must be materialized into a column first (step 2 does that for `net_amount`).

### Import existing semantics instead of authoring

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
relationship. The `source: unbound:*` and `TODO_BIND` join columns are
placeholders: the import gives you structure, and you bind it to physical tables
and a deployment target before pushing, which is what the hand-authored `sales`
model above already has. For the full OWL mapping — class hierarchies, unique
keys, and the constructs carried as custom extensions — see
[Importing an OWL ontology](owl-import.md).

The rest of this codelab uses the hand-authored `sales` model above.

---

## 2. Hydrate the data

An ontology-driven data-engineering agent would produce this data from raw
sources. For a self-contained run, create the three tables directly. `net_amount`
is materialized on `orders` (the measure aggregates it), and each order fans out
into several `lineitem` rows:

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

> **Why data comes before the pushes.** `kcmd push` does more than register the
> model. It validates that every entity's `source` table resolves in BigQuery,
> even under `--validate-only`, and the BigQuery graph is built over these
> tables. So the tables must exist before the Knowledge Catalog push (step 3) and
> the BigQuery push (step 4).

---

## 3. Govern it in Knowledge Catalog

The same model becomes governed catalog entries. First preview the plan without
writing anything:

```bash
kcmd push --target kc --validate-only --print
```

```
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
```

Then drop `--validate-only` to perform the write:

```bash
kcmd push --target kc
```

```
Pushing semantic model (Knowledge Catalog)...
Wrote 5 new and 0 updated Knowledge Catalog entries; linked 2 relationships.
```

Each entity, the metric, and the model itself are now governed entries, joined by
a schema-join link — discoverable, access-controlled, and the single definition
every downstream step reads from. `kcmd pull` reconstructs the model YAML from
these entries, confirming the round-trip.

> This write needs the `semantic-model` / `semantic-entity` / `semantic-metric`
> entry types and write access to the entry group. See
> [Permissions](reference.md#permissions).

---

## 4. Get reliable insights with BigQuery

Deploy the model to BigQuery Graph. `--print` shows the generated DDL:

```bash
kcmd push --target bq --print
```

The generated graph turns each entity into a node table, each relationship into an
edge, and the metric into a measure (your `$PROJECT`/`$DATASET` appear in the fully
qualified names):

```sql
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

The graph is now a resource in your dataset, and the console draws its schema as
a diagram of node and edge tables — easier to read than the DDL above. Print the
BigQuery Studio link to the dataset:

```bash
echo "https://console.cloud.google.com/bigquery?project=$PROJECT&ws=!1m4!1m3!3m2!1s$PROJECT!2s$DATASET"
```

Open the link, expand the `$DATASET` dataset in the Explorer, and click the
`$GRAPH` property graph. Its schema renders as a visual graph of the nodes and
the edges that connect them.

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

## 5. Clean up

Drop the BigQuery dataset (tables + property graph):

```bash
bq rm -r -f -d $PROJECT:$DATASET
```

Remove the Knowledge Catalog entries and entry group via REST:

```bash
TOKEN=$(gcloud auth application-default print-access-token)
EG=projects/$PROJECT/locations/$LOCATION/entryGroups/$DATASET

for E in sales sales.entities.orders sales.entities.customer sales.entities.lineitem sales.metrics.revenue; do
  curl -s -X DELETE -H "Authorization: Bearer $TOKEN" \
    "${DATAPLEX_ENDPOINT:-https://dataplex.googleapis.com}/v1/$EG/entries/$E" >/dev/null
done
curl -s -X DELETE -H "Authorization: Bearer $TOKEN" "${DATAPLEX_ENDPOINT:-https://dataplex.googleapis.com}/v1/$EG"
```
