# SemanticCatalog: the semantic models as a Spanner property graph

Search for concepts, then traverse to everything they depend on, in one query.

Built and run against a real Spanner instance. Every query in `queries.sql`
has been executed; the numbers and shapes below are from that run, not from
reading documentation.

```
schema.sql        tables, full-text search indexes, the property graph
load.py           reads a directory of OSI models and populates it
queries.sql       twelve canonical queries, each named
run_queries.py    runs them all, so the file stays honest
```

```
gcloud spanner databases create semantic_catalog \
  --instance=my-instance --ddl-file=schema.sql

# the six benchmark models
python3 -I load.py --instance my-instance --corpus benchmark
# the repo's own test models
python3 -I load.py --instance my-instance --corpus fixtures \
  --models ../../../tests/libts/semantic/fixtures
# the commerce demo
python3 -I load.py --instance my-instance --corpus demo \
  --models ../../../demo/semantic-model/skill/catalog/EntryGroups/commerce_demo

python3 -I run_queries.py --instance my-instance
```

Three corpora share one graph. Each is tagged on `SemanticModel.corpus` and
reloading one replaces only its own rows, so the repo's test models can sit
beside the curated ones as extra distractors without mixing into them.

| corpus | models | entities | metrics |
|---|---|---|---|
| `benchmark` | 6 | 57 | 137 |
| `fixtures` | 21 | 48 | 38 |
| `demo` | 1 | 3 | 0 |
| **total** | **28** | **108** | **175** |

Plus 287 `READS` edges, 92 `JOINS` and 9 `EXTENDS`. All 21 repo fixtures load
without modification, including the deliberately degenerate ones
(`keyless_dimension`, `sales_bad_target`); they are test scaffolding rather
than realistic models, which is why they are tagged apart.

## This is not the graph kcmd already deploys

`spanner.ts` emits a property graph over a model's *data* tables — nodes are
customers and orders. This is a **catalog graph**: nodes are the model
elements. Two Spanner property graphs with opposite contents, so they need
different names in conversation.

The catalog graph fixes two things the data graph structurally cannot do:

- Spanner Graph has no `MEASURE`, so model-level metrics have no home there
  (`spanner.ts:14`). Here a `Metric` is a first-class node.
- Spanner Graph carries no per-element `OPTIONS`, so descriptions and synonyms
  have nowhere to live (`spanner.ts:17`). Here they are column *values*, which
  makes them full-text searchable — including the synonyms that the Knowledge
  Catalog push drops entirely.

## Shape

Nodes `Model`, `Entity`, `Field`, `Metric`. Edges `HAS_FIELD`, `READS`,
`TOUCHES`, `JOINS`, `EXTENDS`. `Entity` interleaves in `SemanticModel`, `Field`
in `Entity`, `Metric` in `SemanticModel`, so a model and everything under it
is one locality group and `DELETE FROM SemanticModel` cascades.

Each node table carries a hidden `TOKENLIST` generated from its name,
description, instructions and synonyms, with a `SEARCH INDEX` over it.

## What the live run settled

**`SEARCH()` works inside `GRAPH ... MATCH`.** I expected to need two phases —
search for seed keys in SQL, then a graph query filtered by `IN UNNEST(@ids)`.
Not necessary. `WHERE SEARCH(m.search_tokens, '...')` runs inside a graph
statement and resolves against the HIDDEN tokenlist, so question-to-closure is
a single query.

**A table can be both a node table and an edge table.** `Field` is the `Field`
node and the `HAS_FIELD` edge at once. This is already how the data-graph
emitter handles FK relationships, where the source entity's table doubles as
the edge table (`spanner.ts:290`).

**Inheritance forces two edges, not one.** This is the finding that changed
the schema. `total_exposure` is

```
SUM(card_account.current_balance) + SUM(installment_loan.current_balance)
                                  + SUM(line_of_credit.current_balance)
```

`current_balance` is declared *once*, on the abstract `credit_account`. So a
single "metric reads field" edge gives you one field on an entity with no
table — correct about the model, useless for answering. The loader records
both facts per reference:

| | |
|---|---|
| `ref_entity_id` | where the field is declared → the `READS` edge |
| `named_entity_id` | what the expression wrote → the `TOUCHES` edge |
| `inherited` | whether those differ |

27 of the 265 references are inherited. `READS` returns one field declared on
an abstract entity; `TOUCHES` returns the three concrete tables you have to
query. A dependency answer needs the second, and answering off the first alone
would look complete and be unexecutable.

**Variable-length join paths work.** `MATCH ANY SHORTEST (a)-[j:JOINS]-{1,4}(b)`
returns `order_line_to_sales_order -> sales_order_to_store` for the two
entities `revenue_per_employee` touches. No fixed number of joins would do,
which is the part that genuinely needs a graph rather than a few tables.

**Impact analysis is the same edge backwards.** Eight metrics read
`retail_sales.order_line.discount_amount`; traversing `READS` from the field
rather than the metric lists them.

**`SEARCH()` is AND semantics, and this is the biggest constraint on the whole
idea.** Every token in the query must be present, so one unknown word zeroes
the result:

| query | hits |
|---|---|
| `revenue` | 30 |
| `net revenue` | 10 |
| `net revenue zzz` | **0** |
| `How much did we sell last quarter` | **0** |
| `sell OR revenue` | 31 |

A raw natural-language question therefore retrieves nothing. Anything wiring
this to an NL front end has to extract content words first, or rewrite the
question as an `OR` query. `OR` lifts recall but does not fix the underlying
problem: "sell" matches nothing however it is combined, because no model in
the corpus uses that word. That is vocabulary mismatch, and it needs synonyms
or embeddings, not a better operator.

**Which makes the synonym gap matter here too.** "average order basket" finds
`average_order_value` only because its synonyms are indexed — they are column
values in this schema. The Knowledge Catalog push drops `ai_context.synonyms`
entirely, so the same question against KC would miss.

**Lexical search misses idiom.** "Total outstanding exposure book" finds
`total_exposure`; "money out on the street" returns nothing. The `idiom-miss`
query is kept in `queries.sql` as a standing reminder.

**Loading the repo's own fixtures exposed a real discovery problem.** Seven
separate documents declare a model *named* `sales`:

```
sales  7  actions_place_order, sales_bad_target, sales_bq_graph_target,
          sales_no_target, sales_spanner_graph_target,
          sales_unqualified_source, star_orders_customer
```

They coexist because the catalog keys on the document id, but nothing in the
name distinguishes them to a user searching for "sales". `commerce` and
`tpcds_retail_model` each appear twice as well. A catalog serving many teams
will hit this constantly, and it argues for ranking that can prefer a curated
corpus over scaffolding — which is what the `corpus` column is for.

## Open

- **How much closure before it is noise?** `dependency-closure` returns every
  touched entity. If a metric touches 3 of 8 entities, should the caller get 3,
  or the model with the other 5 marked? Currently 3, with the physical source
  on each so the caller can decide.
- **Ranking.** `SEARCH()` returns matches, not a relevance order; there is no
  scoring in these queries. Ordering results across models — the
  `cross-model-collision` query returns four metrics from three models for the
  bare word "utilization" — needs a score the catalog does not yet produce.
- **No embeddings.** Everything here is lexical. Adding an embedding column
  and `APPROX_COSINE_DISTANCE` alongside the tokenlist is the obvious next
  step, and the `idiom-miss` query is the test it has to pass.
