# Semantic-QA retrieval benchmark

Six semantic models, 200 Knowledge Catalog entries, and 40 natural-language
questions labelled with the concepts a correct answer needs.

It grades **search**, not SQL. The path under test is the one KC is becoming:
a question arrives, the catalog is searched, and it must return the entities
and metrics needed to answer. So the gold labels are KC entry refs, and the
score is retrieval quality — recall@k, MRR, nDCG — against them.

## Layout

```
models/<name>.yaml        6 models: 57 entities, 137 metrics
questions/<name>.yaml     5 questions per model, labelled with gold entries
questions/cross_model.yaml  ambiguous and negative questions
validate.ts               models conform; every gold ref names a real entry
retrieval_eval.py         builds a KC-shaped index and scores a retriever
smoke/trap_check.py       side check that the metric SQL is executable
```

Every model declares kcmd's extended profile, `version: "0.2.0.dev0/google"`,
with `entities` rather than OSI's `datasets`. Two of them need it for
`extends`/`abstract`; the rest use it so the corpus is uniform.

## What is retrievable, and what is not

Verified against the emitter, because it decides what the gold can even say:

| Concept | In KC | Searchable text |
|---|---|---|
| Model | `semantic-model` entry | displayName, description, `ai_context.instructions` |
| Entity | `semantic-entity` entry | the above, plus the schema aspect's field names and descriptions |
| Metric | `semantic-metric` entry | the above, plus owning entity |
| Relationship | `schema-join` entry **link** | **none** — endpoints and join columns only |
| Field | not an entry | text inside its entity's schema aspect |

Two consequences shape the whole benchmark.

**Relationships are not refs.** They are links, traversed after retrieval
rather than returned by it, so asking search to return one would grade
something KC does not do. Questions that need a join path say so in `why`.

**`ai_context.synonyms` never reaches KC.** `knowledge_catalog.ts:467` —
*"Only `instructions` is routed here; `ai_context.synonyms`/`examples` have no
home in this aspect."* Synonyms reach the BigQuery graph and not the catalog.
The models carry rich synonyms (`AOV`, `DPD`, `OTD`, `ALOS`, `logos`), so the
harness can index them or not, and the difference measures what closing that
gap is worth. See the numbers below.

## Question format

```yaml
model: retail_sales

questions:
  - id: q2
    difficulty: medium
    question: Which categories have the worst margin percentage?
    expect:
      required: [metric:gross_margin_rate, entity:product]
      supporting: [entity:order_line]
      confusable: [metric:gross_margin, metric:discount_rate]
    why: >-
      gross_margin and gross_margin_rate differ by one word and both match
      "margin"; only the rate answers a question about a percentage.
```

Refs are `kind:name` over the three entry kinds — `model`, `entity`, `metric`.
A bare ref resolves against the file's model; `model.kind:name` reaches
another's.

- `required` — missing one is a failed answer
- `supporting` — needed to ground or filter; lower cost to miss
- `confusable` — plausible near-misses that must not outrank the required set
- `forbidden` — on negatives, what must not come back at all

`cross_model.yaml` holds the two kinds no single model can carry: **ambiguous**
questions answerable by more than one model (the validator enforces that they
span 2+ models), and **negatives**, which nothing answers. Negatives are the
precision half — a retriever that always returns its best five entries scores
well everywhere else and fails here.

## The difficulty axis

Retrieval difficulty is not SQL difficulty, so the questions are built on what
makes *search* hard:

- **Vocabulary mismatch.** "How much did we sell" → `net_revenue`. "Money out
  on the street" → `total_exposure`. "Vendors shipping us junk" → `supplier`
  and `defect_rate`.
- **Jargon carried only in synonyms.** `AOV`, `UPT`, `ALOS`, `OTD`, `DPD` —
  the direct probe for the gap above.
- **Near-misses inside a model.** `gross_margin` vs `gross_margin_rate`,
  `delinquency_rate_30plus` vs `_90plus`, `encounter_count` vs
  `unique_patient_count`.
- **Collisions across models.** `collection_rate` (saas) vs `collection_ratio`
  (clinical). `card_utilization` vs `seat_utilization`. "Promotion" as a
  marketing offer in retail and a job change in workforce. "Churn" as revenue
  in saas and as people in workforce, where that model says *attrition*.
- **Multi-concept recall.** The widest needs seven entries from one sentence;
  returning six fails the question.

## Running it

From `toolbox/mdcode`:

```
npx bun benchmark/semantic-qa/validate.ts
python3 -I benchmark/semantic-qa/retrieval_eval.py --compare
```

Baseline, BM25 over the KC-shaped index, 35 answerable questions:

| | as KC indexes today | with synonyms indexed |
|---|---|---|
| recall@5 | 0.360 | 0.471 |
| recall@10 | 0.505 | 0.629 |
| all-required@5 | 0.114 | 0.286 |
| MRR | 0.418 | 0.530 |
| nDCG@10 | 0.357 | 0.479 |
| forbidden in top-5 (of 5 negatives) | 2 | 2 |

Two things to read off that. The set is **not saturated** — a strong lexical
baseline gets a third of the required entries into the top five, so there is
room to rank approaches. And **indexing synonyms is worth about eleven points
of recall@5 and twelve of nDCG**, concentrated in the easy questions, which go
from 0.429 to 0.786 because that is where the jargon probes live.

### Plugging in real search

`retrieval_eval.py` ships a BM25 baseline so the harness runs today. It is
**not** Knowledge Catalog search — there is no KC search caller on this branch
to drive. To score the real thing, write a function with the same shape as
`bm25_search`, returning `(score, ref)` pairs, and the scoring code takes it
unchanged. Mapping live results back to refs means reading the entry id, which
is why the gold is expressed in entry terms rather than field terms.

## What is not validated

- **No live KC run.** Every number above is the local baseline. Nothing here
  tells you what Dataplex search scores.
- **40 questions is a seed set,** not a statistically comfortable one.
  Per-difficulty cells are 10–15 questions, so treat those splits as
  directional.
- **Gold is one author's judgement.** `required` is what I believe a correct
  answer needs; reasonable people would move some entries between `required`
  and `supporting`.

## Side artifact: `smoke/trap_check.py`

Predates the retrieval framing. It builds a SQLite database from
`retail_sales`'s own field expressions and checks all 17 metric expressions
execute, which is still worth knowing — it keeps the corpus honest as
*realistic* models rather than plausible-looking YAML. It also demonstrates
query-correctness traps (counting orders off the line table reads 4 instead of
2), which this benchmark no longer grades.

Two metrics in `retail_sales` fan out when executed as flat SQL —
`revenue_per_employee` and `sales_per_square_foot` divide a line-grain
numerator by a `SUM` over a store-grain column, giving 8.29 where the
grain-correct answer is 20.14. A grain-aware engine collapses the denominator.
Irrelevant to retrieval; recorded so nobody executes them naively.
