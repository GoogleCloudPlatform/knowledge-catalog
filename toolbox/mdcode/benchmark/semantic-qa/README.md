# Semantic-QA benchmark

Two semantic models, and five questions each, graded against them.

Each model is an OSI document declaring entities, the relationships between
them, and model-level metrics defined over both. Each question names, in a
`uses` list, the metrics and dimensions a correct answer has to touch. That
pairing is the point: a set of questions alone measures whether a system
produces plausible SQL, while questions plus the model elements they require
measures whether it took the right path at the right grain.

## Layout

```
models/retail_sales.yaml       star schema, many-to-many bridge, grain traps
models/lending_credit.yaml     abstract supertype over three subtypes
questions/<name>.yaml          five questions, easiest first
validate.ts                    both models load, conform, and every name resolves
smoke/trap_check.py            runs the metric SQL on real rows
```

A model file and its question file share a stem, and the model's `name`
matches that stem. `validate.ts` enforces all three.

## The two models

**`retail_sales`** — eight entities, seven relationships, seventeen metrics.
A classic star schema: sales lines hanging off orders, with customer, product,
store and calendar dimensions, plus one bridge entity for the many-to-many
between a sales line and the promotions applied to it. It tests the two
failure modes that dominate real BI: measures living at a grain other than the
one the question asks about, and joins that silently multiply rows.

**`lending_credit`** — ten entities, nine relationships, twenty-seven metrics.
`credit_account` is abstract, with three concrete subtypes that have genuinely
different economics: a revolving card, an amortizing installment loan, and a
drawable line of credit. Payments and daily delinquency snapshots attach to
the *supertype*. It tests polymorphic aggregation — reaching all three
subtypes when the question is about exposure, and exactly one when the
question is about utilization, which only means something where a credit limit
exists.

Both declare kcmd's extended profile, `version: "0.2.0.dev0/google"`, and use
`entities` rather than OSI's `datasets`. `lending_credit` needs it for
`extends` and `abstract`, which released Apache OSI has no equivalent for;
`retail_sales` uses the same profile so the set is consistent to read.

Every entity carries a `source` pointing at a plausible fully-qualified table,
so a model is executable in principle, but no data ships with the benchmark.
Nothing depends on a particular backend.

## Question format

```yaml
model: retail_sales

questions:
  - id: q3
    difficulty: medium
    question: What is the average order value by sales channel?
    uses: [average_order_value, sales_order.channel]
    answer: >-
      Line-grain revenue divided by a DISTINCT count of orders, grouped by
      sales_order.channel. The denominator is the trap: once order_line is in
      the join, a plain row count counts lines rather than orders.
```

`uses` entries are either a bare metric name or an `entity.field` dimension,
written exactly as the model declares them. Fields inherited through `extends`
count as belonging to the subtype, so `credit_account.current_balance` resolves
on each of the three subtypes.

`answer` is reference reasoning, not reference SQL. Several correct queries
exist for most of these, so grading on SQL text would punish the wrong thing;
where there is a specific wrong answer worth catching, the `answer` names it.

Five questions per model, ordered easiest first, currently two easy, one
medium and two hard in each. `validate.ts` enforces the count and that the
difficulties vary, so the shape cannot drift by accident.

## Running the checks

From `toolbox/mdcode`:

```
npx bun benchmark/semantic-qa/validate.ts
python3 -I benchmark/semantic-qa/smoke/trap_check.py
```

`validate.ts` loads both models through `src/libts/semantic/loader.ts` — the
same loader kcmd uses — and checks that:

- each model loads, declares exactly one semantic model, and matches its filename
- each validates against the vendored Apache OSI JSON Schema, allowing only
  the three departures the extended profile implies (the `/google` version
  string, `entities` for `datasets`, and `extends`/`abstract` on a dataset),
  and only on a document that actually declares that profile
- every `entity.field` pair in a metric expression exists, resolving `extends`
  transitively
- every name in every `uses` list resolves
- each model has five questions spanning more than one difficulty

Run it after editing anything here. A `uses` entry citing a metric the model
renamed is a broken grading key, and nothing else catches that.

## What has been validated, and what has not

Validated:

- **The models are structurally sound.** Both load, both pass the OSI schema
  check, and every `uses` name resolves.
- **The metric SQL executes.** `smoke/trap_check.py` builds a SQLite database
  whose views are generated from `retail_sales`'s own field expressions, loads
  a seven-line fixture, and runs all 17 metric expressions. All 17 execute,
  with values small enough to check by hand — net revenue 705, average order
  value 176.25 over four orders.
- **The hard questions discriminate.** The same script runs each trap
  question's correct query beside the naive one. All five diverge, and not
  marginally: orders per store reads 4 instead of 2 (q4), discount by
  promotion totals 65 instead of 45 (q5), revenue per employee 9.63 instead of
  38.50.

Not validated:

- **No QA system has been run against it.** Nothing here tells you whether a
  current text-to-SQL or agent setup scores 40% or 95%. The traps are real,
  but difficulty calibration is unmeasured and the labels are editorial
  judgment.
- **No gold values.** No data ships, so there is no exact-match answer key.
  Score on whether the query uses what `uses` names, and whether the result
  has the right grain.
- **`uses` is one correct path, not the only one.** Grade with tolerance;
  strict set equality will produce false negatives.

### Known caveat: two metrics fan out as written

`retail_sales.revenue_per_employee` and `sales_per_square_foot` divide a
line-grain numerator by `SUM(store.employee_count)` and
`SUM(store.square_feet)`. Executed literally over a flat star join the
denominator repeats once per sales line: the smoke test returns 8.29 and 0.083
where the grain-correct answers are 20.14 and 0.201, a factor of 2.4 on that
fixture and worse as basket size grows.

A grain-aware semantic engine collapses the denominator and both are right;
anything executing the expression as plain SQL gets the fan-out. Each metric's
`description` says so. Left as is deliberately, but if you want the models safe
to execute naively, rewrite both denominators as uncorrelated subqueries over
`store`.

## Adding to the benchmark

Add a model as `models/<name>.yaml` with `name: <name>` inside, add
`questions/<name>.yaml` with five questions, and run the validator.

Earlier revisions of this set carried six models and 152 questions, including
unanswerable and deliberately ambiguous cases. Those were cut to keep the set
small enough to read in one sitting; the git history has them if a wider set
is ever wanted.
