# Semantic-QA benchmark

Six semantic models, and 152 natural-language questions graded against them.

Each model is an Apache OSI document declaring datasets (entities),
relationships between them, and model-level metrics defined over both. Each
question states, in a machine-readable `requires` block, exactly
which metrics, dimensions and relationships a correct answer has to use. That
pairing is the point: a benchmark of questions alone measures whether a system
produces plausible SQL, while a benchmark of questions plus their required
model elements measures whether it produces the *right* SQL for the semantics
it was handed.

## Layout

```
models/<name>.yaml        one semantic model, loadable by kcmd's OSI loader
questions/<name>.jsonl    one question per line, graded against models/<name>.yaml
validate.ts               checks every model loads and every question reference resolves
smoke/trap_check.py       runs the metric SQL on real rows; proves the traps diverge
smoke/snapshot_check.py   the same, for supply_chain's daily stock snapshot
```

A model file and its question file share a stem, and the model's `name` matches
that stem. `validate.ts` enforces all three.

## The six models

| Model | Entities | Rel. | Metrics | Q | The shape it tests |
|---|---|---|---|---|---|
| `retail_sales` | 8 | 7 | 17 | 24 | Star schema; one many-to-many bridge; order grain vs line grain |
| `saas_subscriptions` | 10 | 10 | 23 | 25 | Inheritance over billing documents; state entity vs event log |
| `clinical_encounters` | 11 | 13 | 20 | 25 | Two independent bridges off one fact; four-deep join paths |
| `supply_chain` | 10 | 15 | 23 | 25 | Recursive bill of materials; two edges to the same entity; snapshots |
| `lending_credit` | 10 | 9 | 27 | 26 | Abstract supertype with three subtypes; edges onto the supertype |
| `workforce_org` | 8 | 14 | 27 | 27 | Two self-referential hierarchies that disagree; subject vs reviewer edges |

The models are deliberately not variations on one schema. Between them they
cover additive and non-additive measures, ratio metrics whose numerator and
denominator sit on different entities, stock-versus-flow pairs, snapshot
entities that must be read at a single date, inheritance, many-to-many bridges,
and two kinds of recursion.

Every dataset carries a `source` pointing at a plausible fully-qualified table,
so a model is executable in principle, but no data ships with the benchmark.
Nothing in the models depends on a particular backend.

### Portability

Four of the six — `retail_sales`, `clinical_encounters`, `supply_chain` and
`workforce_org` — validate against the released Apache OSI v0.2.0.dev0 JSON
Schema with no deviation whatsoever. They declare `version: "0.2.0.dev0"` and
use OSI's own `datasets` key.

`saas_subscriptions` and `lending_credit` need entity inheritance, which
released OSI does not yet have, so they declare kcmd's extended profile
(`version: "0.2.0.dev0/google"`) and depart from the schema in exactly three
ways: that version string, `entities` in place of `datasets`, and
`extends`/`abstract` on a dataset. `validate.ts` permits those three and
nothing else, and only on a document that declares the extended profile.

One consequence worth knowing: released OSI gives a relationship no
`description` property. Relationship guidance in these models therefore lives
in `ai_context.instructions`, which is where a model consumer should be
reading it anyway.

## Question format

One JSON object per line:

```json
{
  "id": "retail_sales.q07",
  "model": "retail_sales",
  "question": "How many orders did each store take last quarter?",
  "category": "fan-out-trap",
  "difficulty": "hard",
  "answerable": true,
  "requires": {
    "metrics": ["order_count"],
    "dimensions": ["store.store_name", "calendar_date.fiscal_quarter"],
    "relationships": ["sales_order_to_store", "sales_order_to_calendar_date"],
    "entities": ["sales_order", "store", "calendar_date"]
  },
  "expected_grain": "one row per store",
  "answer_sketch": "Count distinct sales_order.order_id per store. ...",
  "pitfall": "Joining order_line and counting rows multiplies each order by ..."
}
```

`requires` names elements exactly as the model declares them; a dimension is
`entity.field`, and fields inherited through `extends` count as belonging to
the subtype. `expected_grain` says how many rows a correct answer has.
`answer_sketch` is the reference reasoning, not a reference SQL string —
several correct queries exist for most questions, so grading on SQL text would
punish the wrong thing. `pitfall`, where present, names the specific wrong
answer the question is built to catch.

Questions with `"answerable": false` carry a `reason` instead of an
`answer_sketch`.

### Categories

| Category | n | What it is |
|---|---|---|
| `multi-hop` | 34 | Two or more relationship hops |
| `ratio-metric` | 20 | A ratio whose parts may sit at different grains |
| `metric-by-dimension` | 14 | One metric, one grouping |
| `multi-metric` | 14 | Two or more metrics read together |
| `unanswerable` | 12 | Out of the model's scope entirely |
| `inheritance` | 11 | Spans, or must scope to, a supertype or subtype |
| `many-to-many` | 8 | Crosses a bridge entity |
| `hierarchy` | 8 | Needs a recursive walk |
| `single-metric` | 6 | One metric, no grouping |
| `ranking` | 6 | Order and limit |
| `ambiguous` | 6 | Underspecified; the model supports several readings |
| `filtered-metric` | 5 | One metric under a non-trivial filter |
| `time-filter` | 3 | Correct period or as-of-date selection |
| `time-series` | 3 | Grouped by a time grain |
| `fan-out-trap` | 2 | A join that silently multiplies rows |

Difficulty splits 48 `easy`, 66 `medium`, 38 `hard`. It reflects how many ways
there are to get the question wrong, not how long the query is.

## The negative cases

Nineteen of the 152 questions are not answerable, and they are the most
discriminating part of the set. They split two ways.

`unanswerable` questions ask for something the model has no entity for — market
share in `retail_sales`, customer acquisition cost in `saas_subscriptions`,
timesheet hours in `workforce_org`. A system that answers them anyway is
hallucinating a schema. The failure mode worth catching is the *plausible*
substitution: using `purchase_order_value` as a stand-in for cost of goods sold
when asked for inventory turns produces a number, and the number is wrong.

`ambiguous` questions have several defensible readings that the model supports
separately and that disagree. "What is our best-selling product?" resolves
differently by units than by revenue than by margin. A correct response names
the ambiguity; silently picking one reading and presenting it as the answer is
the failure.

One question sits in between. `clinical_encounters.q09` is categorized
`fan-out-trap` but marked unanswerable: joining both the diagnosis and
procedure bridges to `encounter` at once yields a cross product, so no single
flat join can answer it correctly, and the only route is to resolve one bridge
to a set of encounter ids first.

## Running the validator

From `toolbox/mdcode`:

```
npx bun benchmark/semantic-qa/validate.ts
```

It loads every model through `src/libts/semantic/loader.ts` — the same loader
kcmd uses — and checks that:

- each model loads, declares exactly one semantic model, and matches its filename
- each model validates against the vendored Apache OSI JSON Schema, allowing
  only the three extended-profile departures described above
- every `entity.field` pair appearing in a metric expression exists, resolving
  `extends` transitively
- every question id is unique and prefixed with its model
- every name in every `requires` block resolves against the model
- answerable questions carry an `answer_sketch`; unanswerable ones carry a `reason`
- every model has questions

It exits non-zero and prints each failure on its own line. Run it after editing
anything here: a `requires` block that cites a metric the model renamed is a
broken grading key, and nothing else catches that.

## Suggested grading

The benchmark does not prescribe a harness. What the `requires` blocks make
cheap is a three-part score per question:

1. **Element recall.** Of the metrics, dimensions and relationships in
   `requires`, how many does the system's query actually use? This is
   checkable by parsing the generated SQL, and it catches a system that
   reached the right number down the wrong path.
2. **Grain.** Does the result have the row count `expected_grain` describes?
   Most fan-out errors show up here before they show up in the values.
3. **Refusal.** On the 19 non-answerable questions, did the system decline or
   ask, rather than answer? Score these separately — a system that scores well
   on the other 133 by answering everything confidently has not earned it.

Element recall and refusal need no warehouse. Checking values does, and the
benchmark ships no data; populating the `source` tables is left to whoever
needs value-level grading.

## What has been validated, and what has not

Validated:

- **The models are structurally sound.** All six load through kcmd's loader and
  pass the OSI schema check. Every `requires` name in all 152 questions
  resolves.
- **The metric SQL executes.** `smoke/trap_check.py` builds a SQLite database
  whose views are generated from `retail_sales`'s own field expressions, loads
  a seven-line fixture, and runs all 17 metric expressions. All 17 execute,
  and the values are small enough to check by hand (net revenue 705, AOV
  176.25 over four orders).
- **The traps discriminate.** For each trap question the same script runs the
  correct query beside the naive one and compares. All five diverge, and not
  marginally: orders per store reads 4 instead of 2, revenue per employee
  9.63 instead of 38.50, promotional discount totals 65 instead of 45.
  `smoke/snapshot_check.py` repeats the exercise on `supply_chain`, where
  summing a daily snapshot across three days values inventory at 7,180 instead
  of 1,980. Three of its four cases diverge; the fourth does not because that
  fixture never has a part dip below safety stock and recover, not because the
  question is weak.

Not validated:

- **No QA system has been run against it.** Nothing here tells you whether a
  current text-to-SQL or agent setup scores 40% or 95%. The traps are real,
  but difficulty calibration is unmeasured and the `easy`/`medium`/`hard`
  labels are editorial judgment.
- **No gold values.** No data ships, so there is no exact-match answer key.
  Scoring is element recall, grain and refusal (above).
- **`requires` is one correct path, not the only one.** Several questions admit
  more than one legitimate join path. Grade recall with tolerance; strict set
  equality will produce false negatives.

### Known caveat: two metrics fan out as written

`retail_sales.revenue_per_employee` and `sales_per_square_foot` divide a
line-grain numerator by `SUM(store.employee_count)` and `SUM(store.square_feet)`.
Executed literally over a flat star join, the denominator repeats once per
sales line: the smoke test returns 8.29 and 0.083 where the grain-correct
answers are 20.14 and 0.201, a factor of 2.4 on this fixture and worse as
basket size grows.

Whether that is a defect depends on the consumer. A grain-aware semantic engine
collapses the denominator and these are right; anything that executes the
expression as plain SQL gets the fan-out. Each metric's `description` says so,
and questions q15 and q19 are built around exactly this hazard. Left as is
deliberately, but if you want the models to be safe to execute naively, rewrite
both denominators as uncorrelated subqueries over `store` and keep the trap in
the questions.

## Adding to the benchmark

Add a model as `models/<name>.yaml` with `name: <name>` inside, add
`questions/<name>.jsonl`, and run the validator. Prefer plain `version:
"0.2.0.dev0"` with OSI's `datasets` key, so the model stays portable; reach for
`"0.2.0.dev0/google"` only when it genuinely needs `extends`, `abstract` or
`deployment_target`, which released OSI rejects.

New categories must be added to the `CATEGORIES` set in `validate.ts` — the
check is a closed vocabulary on purpose, so a typo in a category name fails
rather than silently creating a bucket of one.
