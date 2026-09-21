# Codelab: turn a semantic model into an Agent Skill, and give it to an agent

A semantic model says what a business is, what may be done to it, and under what
rules. In this codelab you'll take one, generate an
[Agent Skill](https://agentskills.io) from it with a single command, and hand
that skill to a 300-line Python agent that knows nothing else. Then you'll watch
the agent read the store, refuse two requests, apply two more, and report a
warning on one of those — none of which is written in the agent.

Then you'll point the same model at a second database, regenerate, and run the
same agent unchanged.

About 30 minutes, most of it waiting on cloud resources.

## What you'll end up believing, or not

The argument the demo is making, so you can watch for whether it holds:

- **The skill is generated, not written.** Change the model, regenerate. There's
  no second copy of the business to keep in step with the first.
- **The agent is not where the business lives.** `agent/agent.py` has no table
  name in it, no rule, no mention of credits or orders. Point it at a skill
  generated from some other model and it's some other agent.
- **The physical database is a detail of the binding, not of the model.** The
  same `commerce.yaml` runs on Spanner and on BigQuery. Between them the tables
  are named differently, and one binding writes GoogleSQL against `LineItem`
  while another writes it against `my-project.semantic_skill_demo.line_item`.

And one thing to be clear about before you start, because otherwise step 7 will
mislead you: **`kcmd` compiles the model and generates the skill. It does not
ship an action runner or a rule judge.** Nothing in this repository sits between
the agent and the database. When the agent refuses a request in step 7, it
refuses because the skill told it the rule and it chose to. Step 10 is about
what that does and doesn't buy you.

## What you need

- `kcmd`, built from this repository: `npm install && npm run build` in
  `toolbox/mdcode`, which leaves the binary at `dist/kcmd`. Put it on your
  `PATH`.
- Python 3.10 or later, for the agent.
- A Google Cloud project with Spanner, BigQuery and Vertex AI enabled, and
  `gcloud auth application-default login` done.
- A Spanner instance to create a database on.

Every command below runs from this directory. The files here ship with
`my-project` and `my-instance` in them, so start by putting your own names in:

```bash
export PROJECT=my-project      # your project
export INSTANCE=my-instance    # your Spanner instance
export DATABASE=semantic_skill_demo
export GOOGLE_CLOUD_PROJECT="$PROJECT"

sed -i "s/my-project/$PROJECT/g; s/my-instance/$INSTANCE/g" \
  catalog.yaml schema.bigquery.sql \
  catalog/EntryGroups/commerce_demo/commerce.profiles/*.yaml
```

Those are working-copy edits for the run, not something to commit.

Install the agent's dependencies:

```bash
python3 -m venv .venv
.venv/bin/pip install -r agent/requirements.txt
```

## 1. Read the model

`catalog/EntryGroups/commerce_demo/commerce.yaml` is the whole business. Open
it — it's commented throughout — but these are the parts the rest of the codelab
turns on.

Three entities, named the way the business talks about them:

```yaml
entities:
  - name: Customer
    primary_key: [customerId]
    ...
  - name: Order
    description: >-
      A customer order. Its total is the sum of its line items: items, tax
      and fees add, credits subtract. A positive total is money owed to the
      company.
    ...
  - name: LineItem
    ...
```

One thing that may be done to it:

```yaml
actions:
  - name: IssueCredit
    description: >-
      Credit a customer against one order -- a late delivery, a coupon, a
      shipping charge applied in error. ...
    parameters:
      - {name: order, concept: Order, field: orderId}
      - {name: amount, type: Decimal}
      - {name: memo, type: String}
    guards:
      - CreditWithinOrderTotal
      - CreditUnderReviewThreshold
      - CreditMemoNamesAServiceFailure
      - CreditIsNotSplitToAvoidReview
```

`order` is projected from `Order.orderId` rather than declared as a bare
`Integer`. That's what lets the generated skill say the argument is a key of a
record that has to exist already — a type alone couldn't say it.

And four rules, in words:

```yaml
constraints:
  - name: CreditWithinOrderTotal
    judgment: >-
      The credit amount requested must not exceed the total of the order
      it is applied to. The `order` argument of this call identifies that
      order, but the order's total is on record rather than stated in the
      arguments: read it before you decide. Read both as dollars.
    on_violation: escalate
    description: >-
      A credit cannot exceed the total of the order it credits. Lower the
      credit amount, or split it across the orders it actually covers.
```

Three things about that block are worth pausing on.

`judgment` is prose, not an expression. The rule is settled by reading it and
deciding, which is why it can say "the total is on record: read it" — a rule
that requires going and looking is a rule a boolean expression over the call's
arguments can't state.

`on_violation` is what to do when it doesn't hold. The four rules here carry all
three values: `escalate` (a person decides), `warn` (report it, let the write
through), and `reject` (don't do it, and there's nobody to refer it to).

A constraint does nothing until an action's `guards` names it. That's the whole
of how a rule takes effect here; a constraint nothing references is inert.

Finally, note the rule that's **not** in the file. "An order's total equals the
sum of its line items" is about the state a write leaves behind, and every rule
above is settled before the write. No guard could reach it. It's in the schema
instead — which is where step 3 picks the thread up.

## 2. Read the binding profiles

`commerce.yaml` contains no table name, no column name, and no SQL. Those are in
`catalog/EntryGroups/commerce_demo/commerce.profiles/`, one file per deployment:

| Profile | Database | Tables | Dialect |
| --- | --- | --- | --- |
| `spanner.yaml` | Cloud Spanner | `Customer`, `Orders`, `LineItem` | GoogleSQL |
| `bigquery.yaml` | BigQuery | `customer`, `orders`, `line_item` | GoogleSQL |
| `alloydb.yaml` | AlloyDB | `customer`, `purchase_order`, `order_line` | PostgreSQL |

Each maps the same logical field to whatever the column is actually called:

```yaml
# spanner.yaml                    # alloydb.yaml
- name: Order                     - name: Order
  source: .../tables/Orders         source: .../tables/purchase_order
  fields:                           fields:
    - {name: total,                   - {name: total,
       expression: total}                expression: order_total}
```

And each supplies the SQL that performs the action:

```yaml
# spanner.yaml
actions:
  - name: IssueCredit
    executor:
      sql:
        statements:
          - >-
            INSERT INTO LineItem (line_item_id, order_id, type, amount, memo)
            VALUES (GENERATE_UUID(), @order, 'credit', -@amount, @memo)
```

One statement. Not two — and that's a design choice worth the paragraph it
takes, which is what step 3 is about.

## 3. Create the store

```bash
gcloud spanner databases create "$DATABASE" \
  --instance="$INSTANCE" --project="$PROJECT" \
  --ddl-file=schema.spanner.sql
```

Open `schema.spanner.sql` before you run it. There are three tables — `Customer`,
`OrderHeader` and `LineItem` — and then this:

```sql
CREATE OR REPLACE VIEW Orders SQL SECURITY INVOKER AS
  SELECT o.order_id,
         ANY_VALUE(o.customer_id) AS customer_id,
         ANY_VALUE(o.placed_on) AS placed_on,
         ANY_VALUE(o.status) AS status,
         COALESCE(SUM(li.amount), 0) AS total
  FROM OrderHeader AS o
  LEFT JOIN LineItem AS li ON li.order_id = o.order_id
  GROUP BY o.order_id
```

An order's total is a view over its lines, not a column on the order. That's the
schema keeping the rule step 1 said no guard could keep: a total derived from
the lines cannot disagree with them, because there's nothing to disagree.

What it buys the action is the single statement you just read. If the total were
a stored column, crediting an order would be two writes — insert the line,
update the total — and they'd have to land together or not at all. As one
statement, it's atomic on every backend without anyone promising a transaction.
`statements` is a list and the list is ordered, but nothing in the model
promises a backend commits several of them as one unit, and not every backend
can.

(The view is aggregated rather than projected for a reason the file records: a
property graph node table needs a key the engine can verify is unique, and
`GROUP BY o.order_id` makes that inferable. The same view written with a
correlated subquery is rejected with "we cannot verify the specified element key
(`order_id`) is unique".)

Now seed it:

```bash
gcloud spanner databases execute-sql "$DATABASE" \
  --instance="$INSTANCE" --project="$PROJECT" \
  --sql="INSERT INTO Customer (customer_id, name, email) VALUES
    (501, 'Morgan Ellis', 'morgan.ellis@example.com'),
    (502, 'Dana Okafor', 'dana.okafor@example.com')"

gcloud spanner databases execute-sql "$DATABASE" \
  --instance="$INSTANCE" --project="$PROJECT" \
  --sql="INSERT INTO OrderHeader (order_id, customer_id, placed_on, status) VALUES
    (12345, 501, DATE '2026-09-02', 'OPEN'),
    (12346, 501, DATE '2026-09-09', 'OPEN'),
    (12347, 502, DATE '2026-09-15', 'OPEN')"

gcloud spanner databases execute-sql "$DATABASE" \
  --instance="$INSTANCE" --project="$PROJECT" \
  --sql="INSERT INTO LineItem (line_item_id, order_id, type, amount, memo) VALUES
    ('li-12345-1', 12345, 'item', NUMERIC '42.00', 'Cast-iron skillet, 10 inch'),
    ('li-12345-2', 12345, 'tax',  NUMERIC '3.36',  'State sales tax'),
    ('li-12345-3', 12345, 'fee',  NUMERIC '4.50',  'Standard shipping'),
    ('li-12346-1', 12346, 'item', NUMERIC '3.00',  'Replacement handle screw'),
    ('li-12347-1', 12347, 'item', NUMERIC '28.00', 'Enamel dutch oven lid'),
    ('li-12347-2', 12347, 'tax',  NUMERIC '2.24',  'State sales tax')"
```

Check that the view adds up:

```bash
gcloud spanner databases execute-sql "$DATABASE" \
  --instance="$INSTANCE" --project="$PROJECT" \
  --sql="SELECT order_id, total FROM Orders ORDER BY order_id"
```

```
order_id  total
12345     49.86
12346     3
12347     30.24
```

Those three totals are what step 7 exercises: one order big enough to credit
against, one too small, and one nobody touches.

## 4. Push the model, and let it check your SQL

```bash
kcmd push --profile spanner --no-kc --validate-only
```

```
Validating semantic model for Spanner Graph...
Warning: [commerce -> commerce] 1 action(s) reach Knowledge Catalog only; the Spanner push deploys none of them.
Warning: [commerce -> commerce] 4 constraint(s) reach Knowledge Catalog only; the Spanner push deploys none of them.
Validation complete; no changes applied.
Warning: model 'commerce' declares 1 action(s) and 4 constraint(s), which deploy only to Knowledge Catalog; --no-kc excludes that leg, so they will not be deployed. Drop --no-kc to deploy them.
```

Read those warnings as a statement about where things land rather than as
something going wrong. Spanner gets a property graph over the tables. The action
and the four constraints go to Knowledge Catalog, which `--no-kc` skipped — drop
the flag, and `kcmd push --profile spanner` publishes them there too.

The interesting part is what `--validate-only` did on the way. Break a column
name in `spanner.yaml` on purpose:

```yaml
# was: (line_item_id, order_id, type, amount, memo)
INSERT INTO LineItem (line_item_id, order_id, type, amount, note)
```

and push again:

```
Error: action 'IssueCredit' in model 'commerce' (commerce): statement 1 of its sql
executor was rejected by Spanner database
'my-project/my-instance/semantic_skill_demo': Column note is not present in table
LineItem [at 1:61]. Statements reach the store exactly as written, so every table
and column has to be the name the database uses.
```

The push sent the statement to Spanner as a query plan inside a transaction it
never committed, so a statement that can't run is caught here rather than the
first time an agent tries to use it. Put `memo` back before you go on.

## 5. Generate the skill

```bash
kcmd skills-generate --out ./skills --profile spanner
```

```
Wrote skills/commerce/SKILL.md
Wrote skills/commerce/references/issue-credit.md
```

Two files. `SKILL.md` is the router — what this model is, what can be done to
it, how to find a record, and how to perform an action here. One page per action
under `references/` carries the arguments and the rules.

That split is the Agent Skills convention and it's load-bearing: a harness reads
the frontmatter to decide whether the skill is relevant at all, the body when it
picks it, and a reference page only when the agent opens it.

## 6. Read what came out

Worth five minutes, because everything the agent does in step 7 is in here.

From `SKILL.md`, the tables an agent can read — derived from the binding
profile, so an agent doesn't spend its first three turns querying
`INFORMATION_SCHEMA`:

```
Customer -> Customer
  column customer_id (Integer) = Customer.customerId
  column name (String) = Customer.name. The customer's display name, e.g. "Morgan Ellis".
  ...
Order -> Orders
  column order_id (Integer) = Order.orderId. The order's number, which is how both the customer and the desk refer to it.
  ...
  column total (Decimal) = Order.total. What the customer owes on this order, in dollars.
```

Note `Order -> Orders`. The logical name on the left, the view on the right.
Nothing in the skill says it's a view, because nothing reading it needs to care.

And the statement that performs the action, verbatim from the profile:

    ### IssueCredit

    ```sql
    INSERT INTO LineItem (line_item_id, order_id, type, amount, memo) VALUES (GENERATE_UUID(), @order, 'credit', -@amount, @memo)
    ```

with the instruction that goes above it: *"Run what is written and nothing else:
this is what the model says the action is, and a statement composed instead of
this one is a write nobody declared and no rule was written against."*

From `references/issue-credit.md`, the arguments:

| Name | Type | Required | Identifies | What to pass |
| --- | --- | --- | --- | --- |
| `order` | integer | yes | `Order.orderId` | The order's number, which is how both the customer and the desk refer to it. |
| `amount` | number | yes |  | The amount, as a decimal number. |
| `memo` | string | yes |  | The memo, as text. |

The **Identifies** column is the `concept:`/`field:` projection from step 1
arriving where it matters, under a sentence that says what to do about it: *"An
argument with something in Identifies is the key of a record that has to exist
already. Find it; do not invent it."*

And each rule, with its consequence spelled out rather than left as a keyword:

    ### CreditIsNotSplitToAvoidReview

    On violation: `reject` -- a call that does not satisfy it must not be
    performed at all. There is nobody to refer it to.

    > The credit requested must be the whole of what this order is owed, not
    > one piece of a larger amount divided to stay under the 25-dollar
    > self-service ceiling. ...

    If it does not hold: Raise this as a single credit for the full amount and
    send it for supervisor review.

Now open `agent/agent.py` and notice what is *not* in it. No table name. No
column. No credit, no order, no ceiling, no memo rule. It reads the skill
directory into a system prompt, offers one tool — `execute_sql(sql, params)` —
and loops. Everything the agent is about to appear to know, it's about to read.

## 7. Run it

Four requests, one for each way a call can end. Run them in the order below:
each of the last two changes what the next one sees.

The transcripts are from a real run, pasted verbatim. Yours will differ in
wording, and may differ in which statements the agent chooses — the rules are
settled by a language model, and that is what step 10 is about.

### A request that has to read the store before it can be refused

```bash
.venv/bin/python agent/agent.py --skill ./skills/commerce \
  --project "$PROJECT" --instance "$INSTANCE" --database "$DATABASE" \
  "Morgan Ellis wants 4.50 back on order 12346 because the screw arrived bent."
```

```
> Morgan Ellis wants 4.50 back on order 12346 because the screw arrived bent.

  [sql] SELECT total FROM Orders WHERE order_id = @order_id
  [params] {"order_id": 12346}
  [result] 1 row(s).
[
  {
    "total": "3"
  }
]

A credit of 4.50 cannot be applied to order 12346, which has a total of 3.00. A
credit cannot exceed the total of the order it credits. Lower the credit amount,
or split it across the orders it actually covers.
```

This is `CreditWithinOrderTotal`, and it's the rule that justifies writing rules
as prose. The judgment says the total is on record and to go read it, so the
agent did — one `SELECT`, against the view named in the skill's schema map — and
then refused in the constraint's own words, which is why the refusal reads like
the business wrote it. Nothing was written.

### A request that must not be performed at all

```bash
.venv/bin/python agent/agent.py --skill ./skills/commerce \
  --project "$PROJECT" --instance "$INSTANCE" --database "$DATABASE" \
  "We owe Morgan Ellis 20 dollars on order 12345 for the late delivery. Put
   through the first 10 now and I will raise the other half next week."
```

```
> We owe Morgan Ellis 20 dollars on order 12345 for the late delivery. Put through the first 10 now and I will raise the other half next week.

This credit is one part of a larger amount. Raise it as a single credit for the
full amount, and I will send it for supervisor review.
```

`CreditIsNotSplitToAvoidReview`, caught from the request itself, with no tool
call at all — the rule is settleable from what was said, so there was nothing to
look up.

### A request that lands

```bash
.venv/bin/python agent/agent.py --skill ./skills/commerce \
  --project "$PROJECT" --instance "$INSTANCE" --database "$DATABASE" \
  "Morgan Ellis was charged shipping on order 12345 that should have been free.
   Credit the shipping back."
```

```
  [sql] SELECT amount FROM LineItem WHERE order_id = @order_id AND type = 'fee' AND memo = 'Shipping'
  [params] {"order_id": 12345}
  [result] 0 rows.

  [sql] SELECT type, amount, memo FROM LineItem WHERE order_id = @order_id
  [params] {"order_id": 12345}
  [result] 3 row(s).
[
  {
    "type": "item",
    "amount": "42",
    "memo": "Cast-iron skillet, 10 inch"
  },
  {
    "type": "tax",
    "amount": "3.36",
    "memo": "State sales tax"
  },
  {
    "type": "fee",
    "amount": "4.5",
    "memo": "Standard shipping"
  }
]

  [sql] SELECT total FROM Orders WHERE order_id = @order_id
  [params] {"order_id": 12345}
  [result] 1 row(s).
[
  {
    "total": "49.86"
  }
]

  [sql] INSERT INTO LineItem (line_item_id, order_id, type, amount, memo) VALUES (GENERATE_UUID(), @order, 'credit', -@amount, @memo)
  [params] {"order": 12345, "amount": "4.5", "memo": "Credit for shipping charged in error."}
  [result] 1 row(s) changed.

I have credited order 12345 the $4.50 shipping charge. This changed 1 row.
```

Four calls, and the first is the most instructive: the agent guessed the memo
said `Shipping`, got `0 rows`, and widened the query rather than treating the
empty result as an answer. The skill's "Finding a record" section is what told
it to read that count — *"a key that matches no record does not announce itself:
the statement runs, matches nothing, writes nothing, and comes back reporting
zero rows rather than an error."*

Then it read the total, because `CreditWithinOrderTotal` told it to. Then it ran
the `INSERT` — character for character the statement in the skill, with the
arguments bound to the named parameters rather than pasted into the text.

### A request that lands and reports a warning

```bash
.venv/bin/python agent/agent.py --skill ./skills/commerce \
  --project "$PROJECT" --instance "$INSTANCE" --database "$DATABASE" \
  "Give Morgan Ellis 5 dollars back on order 12345 as a goodwill gesture, she
   asked nicely."
```

```
  [sql] SELECT total FROM Orders WHERE order_id = @order_id
  [params] {"order_id": 12345}
  [result] 1 row(s).
[
  {
    "total": "45.36"
  }
]

  [sql] INSERT INTO LineItem (line_item_id, order_id, type, amount, memo) VALUES (GENERATE_UUID(), @order, 'credit', -@amount, @memo)
  [params] {"order": 12345, "amount": 5, "memo": "a goodwill gesture, she asked nicely"}
  [result] 1 row(s) changed.

Applied. A credit of $5.00 has been issued for order 12345, changing 1 row. This
call did not state a specific service failure in the memo, which is required.
```

`CreditMemoNamesAServiceFailure` is `warn`, so the write goes through and the
warning is reported alongside it. This is the ending that's easiest to lose: an
agent that reports only the success is telling the caller the write met every
rule the model states, which is the one thing it didn't. The skill names it as
an ending of its own — "Applied with warnings" — so it doesn't collapse into
"done".

Notice the total the agent read: `45.36`, not the `49.86` from step 3. The
previous credit moved it. Nothing updated a total column, because there isn't
one.

### What landed

```bash
gcloud spanner databases execute-sql "$DATABASE" \
  --instance="$INSTANCE" --project="$PROJECT" \
  --sql="SELECT o.total, li.type, li.amount, li.memo
         FROM Orders AS o JOIN LineItem AS li ON li.order_id = o.order_id
         WHERE o.order_id = 12345 ORDER BY li.amount DESC"
```

```
total  type    amount  memo
40.36  item    42      Cast-iron skillet, 10 inch
40.36  fee     4.5     Standard shipping
40.36  tax     3.36    State sales tax
40.36  credit  -4.5    Credit for shipping charged in error.
40.36  credit  -5      a goodwill gesture, she asked nicely
```

Two credits, two refusals, and a total that's the sum of five lines because it
has never been anything else.

## 8. The same skill against a different database

Create the BigQuery dataset and apply the schema:

```bash
bq mk --dataset --location=us-central1 "$PROJECT:$DATABASE"
bq query --use_legacy_sql=false --project_id="$PROJECT" < schema.bigquery.sql
```

Seed it the same way. The three `INSERT`s from step 3 translate directly: qualify
each table as `` `$PROJECT.$DATABASE.customer` ``, `order_header` and
`line_item`, and drop the `NUMERIC` literal prefixes.

Check the profile against the live dataset, then regenerate:

```bash
kcmd push --profile bigquery --no-kc --validate-only
kcmd skills-generate --out ./skills-bq --profile bigquery --force
```

The same pre-flight runs here, as a dry-run query rather than a Spanner plan.
Then diff the two skills:

```bash
diff -r ./skills/commerce/references ./skills-bq/commerce/references
diff ./skills/commerce/SKILL.md ./skills-bq/commerce/SKILL.md
```

The reference pages are byte-identical — the first `diff` prints nothing.
Arguments, rules, consequences, what the call changes: none of it is a fact
about a database. In `SKILL.md`, every difference falls in a section that says
it's about the binding:

```diff
-gcloud spanner databases execute-sql semantic_skill_demo \
-  --instance=my-instance --project=my-project \
-  --sql='SELECT ...'
+bq query --use_legacy_sql=false --project_id=my-project --dataset_id=semantic_skill_demo \
+  'SELECT ...'

-Customer -> Customer
+Customer -> `my-project.semantic_skill_demo.customer`
-Order -> Orders
+Order -> `my-project.semantic_skill_demo.orders`
-LineItem -> LineItem
+LineItem -> `my-project.semantic_skill_demo.line_item`

-... which is profile `spanner`.
+... which is profile `bigquery`.
-- Store: `my-project/my-instance/semantic_skill_demo`
+- Store: `bigquery:my-project/semantic_skill_demo`

-INSERT INTO LineItem (line_item_id, ...
+INSERT INTO `my-project.semantic_skill_demo.line_item` (line_item_id, ...
```

The BigQuery names come out qualified because BigQuery resolves an unqualified
name against a default dataset, and a statement sent as a bare query — which is
what both the push-time dry run and the agent's `execute_sql` send — doesn't
have one.

Now run the same agent, same file, against it:

```bash
.venv/bin/python agent/agent.py --skill ./skills-bq/commerce --backend bigquery \
  --project "$PROJECT" --dataset "$DATABASE" \
  "Morgan Ellis was charged shipping on order 12345 that should have been free.
   Credit the shipping back."
```

```
Skill: skills-bq/commerce (9376 characters)
Store: BigQuery my-project.semantic_skill_demo
Model: gemini-2.5-pro (global)

> Morgan Ellis was charged shipping on order 12345 that should have been free. Credit the shipping back.

  [sql] SELECT amount FROM `my-project.semantic_skill_demo.line_item` WHERE order_id = @order_id AND type = 'fee'
  [params] {"order_id": 12345}
  [result] 1 row(s).
[
  {
    "amount": "4.5"
  }
]

  [sql] SELECT total FROM `my-project.semantic_skill_demo.orders` WHERE order_id = @order_id
  [params] {"order_id": 12345}
  [result] 1 row(s).
[
  {
    "total": "49.86"
  }
]

  [sql] INSERT INTO `my-project.semantic_skill_demo.line_item` (line_item_id, order_id, type, amount, memo) VALUES (GENERATE_UUID(), @order, 'credit', -@amount, @memo)
  [params] {"order": 12345, "amount": "4.50", "memo": "Credit for shipping charged in error"}
  [result] 1 row(s) changed.

Done. I have credited order 12345 for $4.50 to cover the shipping charge, with
the memo "Credit for shipping charged in error".
```

Different tables, different statements, same behaviour. The only thing that
changed between the two runs is which profile the skill was generated from.

`alloydb.yaml` is the third profile, and this codelab doesn't run it. `kcmd push`
has no AlloyDB client, so the pre-flight that checked the statements against the
store on the other two has nothing to check them with here:

```
Error: model 'commerce' (commerce) deploymentTarget
'//alloydb.googleapis.com/projects/my-project/locations/us-central1/clusters/my-cluster/instances/my-instance/databases/semantic_skill_demo'
is an AlloyDB database, which a model runs against rather than deploys to;
AlloyDB has no property graph for a push to publish. Push under a profile whose
target is a BigQuery or Spanner Graph, and use this one to run actions against.
```

It's in the directory as the honest third case — a profile in a second SQL
dialect, with a differently named column, that `kcmd skills-generate` renders and
nothing here verifies against a live cluster.

## 9. Change the model, regenerate

The claim from the top of this page is cheap to test. Lower the self-service
ceiling in `commerce.yaml` from 25 dollars to 4, in both the judgment and the
description that gets quoted back to the caller:

```yaml
- name: CreditUnderReviewThreshold
  judgment: >-
    The credit amount requested must not exceed 4 dollars, which is the
    self-service ceiling for this desk. Read the amount as dollars.
  on_violation: escalate
  description: >-
    A credit over $4 is above the self-service ceiling. A supervisor
    decides it.
```

```bash
kcmd skills-generate --out ./skills --profile spanner --force
```

Then re-run the request that landed a moment ago — the $4.50 shipping credit:

```
  [sql] SELECT li.amount FROM LineItem AS li JOIN Orders AS o ON li.order_id = o.order_id JOIN Customer AS c ON o.customer_id = c.customer_id WHERE li.type = 'fee' AND o.order_id = @order_id AND c.name = @customer_name
  [params] {"order_id": 12345, "customer_name": "Morgan Ellis"}
  [result] 1 row(s).
[
  {
    "amount": "4.5"
  }
]

  [sql] SELECT total FROM Orders WHERE order_id = @order_id
  [params] {"order_id": 12345}
  [result] 1 row(s).
[
  {
    "total": "40.36"
  }
]

A credit of $4.50 exceeds the $4.00 self-service ceiling for this desk. A
supervisor must approve it.
```

Same reads, opposite ending, and no write. No line of `agent/agent.py` changed
and no prompt was edited: the number lives in one place, and that place is owned
by whoever owns the business rather than by whoever owns the agent. Put the 25
back before you move on.

## 10. What this does and doesn't get you

**Nothing here enforces anything.** The agent has one general `execute_sql` tool.
Nothing in the process stops the model sending a statement nobody declared, or
skipping a rule it found inconvenient. What the skill buys is that it cannot
claim it didn't know: the rule, its consequence, and what to say when it doesn't
hold are all in front of it before it acts. If you want the rules held
mechanically, the tool has to be narrower than this one — one tool per action,
with the statement fixed on the server side and the guards settled before it
runs — and that's a different program from this one.

**The same call can go two ways on two runs.** Every guard is a model call, so
four guards is up to four chances to misread a borderline case. On an earlier run
of the split-credit request in step 7, the agent refused it correctly and then
added *"A credit of that amount needs a supervisor to approve it"* — which is
false, since $20 is under the $25 ceiling. Right decision, invented reason. Test
every rule against a call it should refuse, not only against one it should allow,
and test it more than once.

**A threshold doesn't want to be a judgment.** `CreditUnderReviewThreshold`
compares a number in the call against a constant. That belongs in whatever
dispatches the call, where it's exact and free. It's written as a judgment here
for the contrast with `CreditWithinOrderTotal`, which is about a number on record
and genuinely needs a look, and because the demo needs all three `on_violation`
values. Don't copy it.

**The agent is thin, not clever.** It reads the whole skill up front rather than
lazily, it has no memory between runs, and it takes one request and exits — which
is why its preamble has to tell the model there's nobody to ask a follow-up
question of. A real harness — Claude Code, Gemini CLI, anything else that reads
the Agent Skills layout — does the loading properly and is a better host for this
skill than `agent.py` is. `agent.py` exists to make it obvious how little the host
has to know.

**Two backends were run, not three.** Spanner and BigQuery in this codelab, live.
AlloyDB is generated and not executed.

## 11. Clean up

```bash
gcloud spanner databases delete "$DATABASE" --instance="$INSTANCE" --project="$PROJECT"
bq rm -r -f --dataset "$PROJECT:$DATABASE"
rm -rf ./skills ./skills-bq .venv
git checkout -- catalog.yaml schema.bigquery.sql \
  catalog/EntryGroups/commerce_demo/commerce.profiles/
```

## What's in this directory

| File | What it is |
| --- | --- |
| `catalog.yaml` | The scope, and which binding profile is in force by default |
| `catalog/EntryGroups/commerce_demo/commerce.yaml` | The model: entities, one action, four rules. No physical facts |
| `catalog/.../commerce.profiles/spanner.yaml` | Spanner binding: tables, columns, GoogleSQL executor |
| `catalog/.../commerce.profiles/bigquery.yaml` | BigQuery binding: the same model, snake_case names, qualified statements |
| `catalog/.../commerce.profiles/alloydb.yaml` | AlloyDB binding: a renamed column and PostgreSQL |
| `schema.spanner.sql` | Tables and the `Orders` view the `spanner` profile binds to |
| `schema.bigquery.sql` | The same, as a BigQuery dataset |
| `schema.alloydb.sql` | The same, in PostgreSQL |
| `agent/agent.py` | The agent: loads a skill, offers one SQL tool, knows nothing else |
| `agent/requirements.txt` | Its three dependencies |

Nothing generated is checked in. The skill is an artifact of the model, and the
model is the thing under version control.

## Further reading

- [`docs/semantic-model/skills.md`](../../../docs/semantic-model/skills.md) —
  what `skills-generate` emits, section by section, and why each section is
  there.
- [`docs/semantic-model/actions.md`](../../../docs/semantic-model/actions.md) —
  actions, executors, `affects`, guards and judged constraints in full.
