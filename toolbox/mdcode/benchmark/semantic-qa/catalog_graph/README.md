# SemanticCatalog: the semantic models as a Spanner property graph

Search for concepts, then traverse to everything they depend on, in one query.

Built and run against a real Spanner instance. Every query in `queries.sql`
has been executed; the numbers and shapes below are from that run, not from
reading documentation.

```
schema.sql        tables, full-text search indexes, the property graph
load.py           reads ../models/*.yaml and populates it
queries.sql       nine canonical queries, each named
run_queries.py    runs them all, so the file stays honest
```

```
gcloud spanner databases create semantic_catalog \
  --instance=my-instance --ddl-file=schema.sql
python3 -I load.py        --instance my-instance
python3 -I run_queries.py --instance my-instance
```

Loaded from the six benchmark models: 6 models, 57 entities, 374 fields,
137 metrics, 265 `READS` edges, 68 `JOINS`, 5 `EXTENDS`.

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

**Lexical search misses idiom, and that is worth knowing.** "total outstanding
exposure book" finds `total_exposure`. "Money out on the street" returns
nothing — no token overlap with anything in the corpus. Full-text search has a
floor here that only embeddings or query expansion will lift, and the
`idiom-miss` query is kept in `queries.sql` as a standing reminder.

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
