# Build an agent that acts on a semantic model

This is a recipe. Follow it and you get an agent that takes a natural language
request, checks it against the policy the model states, and changes a row in an
operational store — or declines to, and says which rule stopped it. The point of
the recipe is how little of that turns out to be agent work.

The whole agent is one file, `agent.ts`, 72 lines of code. Not one of them
mentions credits, orders, customers, tables, SQL or a dollar threshold. The file
does five things: it creates the runtime, hires a judge, derives the tools,
adapts them to the framework, and runs. Everything that knows what business this
is lives in the model, and outlives the agent.

They do not mention a database either. [Step 8](#8-run-the-same-agent-against-alloydb)
runs the identical file against AlloyDB instead of Spanner -- different tables,
a different column name, a different SQL dialect -- by setting one environment
variable.

Everything else you need is already a command: `kcmd` for the model and its
actions, `gcloud` for the store, ADK for the agent.

## The scenario

The business is a small ecommerce operation: customers, their orders, and the
lines that make up an order. There is one thing you can do to it: credit a
customer against an order. Policy says when that is allowed, and the model
states it as four constraints, each a sentence a language model settles. The
action names all four in `guards`, which is what puts them between the agent and
the write.

One of those four is about a number the caller never states: a credit may not
exceed the total of the order it credits, and the total is on record. Settling it
takes a judge that has been given those tables to query — `--judge-reads-store`
at a command line, a `store` on the judge this agent hires. The judge writes the
statement, the runtime checks it is a read and prints it, and the rule is
settled against a row rather than against a claim.

[Step 6](#6-run-it) runs the request a support desk gets every day. A customer
was charged for shipping that was supposed to be free, and someone inside the
company has to find the order and put the money back. The request names no
identifier: it gives a customer's name, a holiday, and a description of what
went wrong. It also happens to be over the self-service ceiling, so the interest
is in what the agent does when it is told no.

That is the shape worth testing. A request that already speaks in order ids and
line types proves only that the tools can be called.

## Before you start

You need a cloud project and application-default credentials, which serve the
store, the agent's model, and the judge. Steps 1 to 7 bind the model to Spanner,
so the project needs a Spanner instance. Step 8 does the same against AlloyDB
and says what it needs there; you can stop after step 7 and have a working
agent.

```bash
gcloud auth application-default login
```

Build the CLI from the `toolbox/mdcode` package root. From step 2 on,
everything runs in `demo/semantic-model/agent`, which is why `kcmd` appears as
`../../../dist/kcmd`.

```bash
npm run build                # builds dist/kcmd
(cd demo/semantic-model/agent && npm install)
```

## 1. Write the model

The model is two files, split so that nothing physical appears in the logical
one.

`catalog/EntryGroups/commerce_demo/commerce.yaml` says what the business is:
three entities, the relationships between them, one action, six rules. It names
no table, no column and no SQL. The same file would serve if the orders lived in
another store.

`catalog/EntryGroups/commerce_demo/commerce.profiles/spanner.yaml` says where
the business lives: a table per entity, a column per field, and the two
statements that perform `IssueCredit` — insert a negative line, then recompute
the order total from its lines. A profile may supply physical facts and nothing
else: the loader rejects a profile that adds an entity or changes what an entity
means. So that one file holds everything deployment-specific here, down to which
database the model runs against:

```yaml
deployment_target: //spanner.googleapis.com/projects/my-project/instances/my-instance/databases/semantic_agent_demo/propertyGraphs/commerce
```

`my-project` and `my-instance` are placeholders. Every command and transcript
below shows them in place of the project and instance the captured runs used.
Point this line at your own project and instance, and everything follows it:
the commands below create and drop the database it names, the tools read and
write there, and the agent bills Gemini to the same project unless
`GOOGLE_CLOUD_PROJECT` is already set. There is nothing else to keep in step.

There is a second profile next to it, `alloydb.yaml`, pointing the same model
at a PostgreSQL database instead. It is not used until [step 8](#8-run-the-same-agent-against-alloydb);
it is mentioned here because it is the reason the split is drawn where it is.
The two profiles disagree about tables, about one column name and about SQL
dialect, and `commerce.yaml` is the same bytes under both.

The files sit in a `kcmd` workspace (`catalog.yaml` scopes it and names
`spanner` as the default profile), so the CLI and the agent read the same files
rather than copies that can drift.

### Write the policy down in words

A constraint carries one body, `judgment`: the rule as a sentence, settled by a
language model reading the attempted call. `commerce.yaml` states the credit
policy that way throughout, including the parts of it that are arithmetic.

```yaml
      - name: CreditUnderReviewThreshold
        judgment: >-
          The credit amount requested must not exceed 25 dollars, which is the
          self-service ceiling for this desk. Read the amount as dollars.
        on_violation: escalate
```

Don't copy that one. It compares an argument against a literal, so settling it
costs a model call that can answer two identical calls differently, and
[a threshold like it belongs in whatever dispatches the call](../../../docs/semantic-model/actions.md#what-a-judgment-costs).
It stays here for the contrast with the rule below, which has to read the store,
and because the transcripts further down were captured against it.

The next rule compares the requested amount against `Order.total`, which is a
number on record rather than a number the caller states:

```yaml
      - name: CreditWithinOrderTotal
        judgment: >-
          The credit amount requested must not exceed the total of the order
          it is applied to. The `order` argument of this call identifies that
          order, and the order's total is on record rather than stated in the
          arguments, so read it before answering. Read both as dollars.
        on_violation: escalate
```

A judge handed the attempted call and nothing else cannot settle that rule,
because the total is not in the call. A judge that can query the model's own
tables can: it looks the order up, reads the total back, and compares. That is
what `--judge-reads-store` supplies, and every transcript below prints the
statement the judge ran. The wording has to invite the read. The rule says the
total "is on record rather than stated in the arguments, so read it before
answering", because the judge decides for itself whether to look, and an
unsettled rule counts as not holding.

Reading committed state is not the same as holding a lock. The judge answers
before the transaction opens, so two concurrent credits can each be told the
order has room and jointly exceed the total. That is a rule for the schema or
the transaction, not for a guard.

One rule the policy names is absent from the model for the same kind of reason:
an order's total equalling the sum of its lines is a statement about the state a
write leaves behind. Guards settle before the transaction opens, so nothing
evaluated there can settle it. It belongs inside the transaction or in the
schema, and `commerce.yaml` says so where the rule would have gone.

Two more rules exist *only* because a judge exists, and unlike the pair above
they are about what the caller said rather than about what is stored:

```yaml
      - name: CreditMemoNamesAServiceFailure
        judgment: >-
          The memo argument of this call must name a specific thing that went
          wrong on the order: a late delivery, a damaged item, a shipping
          charge applied in error. A memo saying only that the customer asked,
          or that the credit is goodwill, or giving no reason at all, names no
          failure and does not satisfy this rule.
        on_violation: warn

      - name: CreditIsNotSplitToAvoidReview
        judgment: >-
          The credit requested must be the whole of what this order is owed,
          not one piece of a larger amount divided to stay under the 25-dollar
          self-service ceiling. ...
        on_violation: reject
```

No arithmetic states either one. "Names a specific service failure" is not a
comparison, and neither is "is not a piece of a larger amount". Between the four
rules the demo covers all three consequences `on_violation` can carry:
`escalate` holds the write for a person, `warn` lets it through and reports, and
`reject` refuses outright.

One wording change is worth reporting, because the failure it fixed is silent.
An earlier draft of the memo rule opened `LineItem.memo must name a specific
thing that went wrong`, and the goodwill memo below committed with no warning at
all: the judge held the rule. Changing those four words to `The memo argument of
this call` made it fire on the first retry, and it has fired on every run since.

The likely reason is that `LineItem.memo` is a stored field and that judge read
no stored data, so the rule asked about evidence it did not have. Letting a judge
read does not make the wording safe. The credit line does not exist until the
write runs, so `LineItem.memo` names a row no judge would find even with the
whole database in front of it, while `The memo argument of this call` names
something it is already holding. That is a reason to suspect such a wording
rather than a rule about it — the same field name settles a judgment correctly
in
[the actions guide](../../../docs/semantic-model/actions.md#when-the-rule-is-a-sentence).

What generalises is the failure mode: a judged guard can pass a call it should
have refused, and nothing says so. The judge is told that a rule it has not been
given enough to tell about does not hold, so missing evidence is meant to come
back as a refusal naming what is missing. That is an instruction to a model
rather than a property of the runtime. The goodwill memo is a case where the
model did not follow it: the rule came back held, and a guard that passes prints
nothing. Word a guard in terms of the call's own arguments, and test it against
a case it should refuse.

### Put the persona in the model too

`commerce.yaml` carries a model-level `ai_context`:

```yaml
    ai_context:
      instructions: >-
        You are working an internal operations desk for this business, fixing
        orders on behalf of the people who run it. A request describes an order
        the way a person does -- a customer's name, a day, what went wrong --
        so expect to be given a description where the model expects a number,
        and expect to have to read an order's lines to find out what was
        actually charged.
```

This is the part people reflexively write into the agent's source, and it is the
part that belongs there least. The persona holds for every agent that acts on
this model, including the ones nobody has written yet. A rule an agent keeps to
itself can be changed without the people who own the model finding out.

Only what is specific to *this business* belongs there. How to use a lookup, and
what to do when a write is refused, belong to the derived tools rather than to
commerce, so the derivation supplies them and the model does not repeat them.

The action carries its own `ai_context` for what a caller has to supply, and one
clause in it is there because of a judged rule:

```yaml
            ... and, if this credit is part of a larger amount owed, say that
            and give the total. A rule reads the memo, so a fact left out of it
            is a fact the rule cannot weigh.
```

A judged rule is settled from the call's own arguments, so a fact the caller
leaves out of the memo is a fact no rule can weigh. Telling the caller which
facts a rule reads is therefore part of describing the action.

The persona also settles which of two agents this is. An internal one reads and
writes every customer's orders; a customer-facing one would see only its own
caller's. Only the internal one is built here.

## 2. Create the store

Four `gcloud` commands create the store, and none of them names a database. Ask
the model where it lives instead — `kcmd action list --store` prints the
deployment target as `project/instance/database` and nothing else, so a shell
can read it:

```bash
cd demo/semantic-model/agent
IFS=/ read -r PROJECT INSTANCE DATABASE <<<"$(../../../dist/kcmd action list --store)"
```

Naming it a second time here is how you end up seeding one database while the
agent talks to another.

```bash
gcloud spanner databases create "$DATABASE" \
  --instance="$INSTANCE" --project="$PROJECT" --ddl-file=schema.spanner.sql
```

`schema.spanner.sql` creates three tables. It is a file rather than a command
because `--ddl-file` wants one, and because `kcmd push` deploys a graph over
tables that already exist rather than creating them. Its sibling
`schema.alloydb.sql` holds the same three entities in PostgreSQL; neither is the
real schema, which is the point.

Then seed the rows: two customers, three orders, six line items. Order 12345 is
the one the request is about, placed on Labor Day 2026 and carrying the $30
shipping charge that was not supposed to be there.

```bash
gcloud spanner databases execute-sql "$DATABASE" \
  --instance="$INSTANCE" --project="$PROJECT" \
  --sql="INSERT INTO Customer (customer_id, name, email) VALUES
    (1, 'Morgan Ellis', 'morgan.ellis@example.com'),
    (2, 'Dana Reyes', 'dana.reyes@example.com')"

gcloud spanner databases execute-sql "$DATABASE" \
  --instance="$INSTANCE" --project="$PROJECT" \
  --sql="INSERT INTO Orders (order_id, customer_id, placed_on, total, status) VALUES
    (12345, 1, DATE '2026-09-07', NUMERIC '165.85', 'OPEN'),
    (12346, 1, DATE '2026-08-20', NUMERIC  '18.00', 'OPEN'),
    (12347, 2, DATE '2026-09-02', NUMERIC '200.00', 'OPEN')"

gcloud spanner databases execute-sql "$DATABASE" \
  --instance="$INSTANCE" --project="$PROJECT" \
  --sql="INSERT INTO LineItem (line_item_id, order_id, type, amount, memo) VALUES
    ('li-12345-1', 12345, 'item', NUMERIC  '89.99', 'Cast iron skillet'),
    ('li-12345-2', 12345, 'item', NUMERIC  '34.50', 'Enamel saucepan'),
    ('li-12345-3', 12345, 'fee',  NUMERIC  '30.00', 'Shipping'),
    ('li-12345-4', 12345, 'tax',  NUMERIC  '11.36', 'Sales tax'),
    ('li-12346-1', 12346, 'item', NUMERIC  '18.00', 'Silicone spatula set'),
    ('li-12347-1', 12347, 'item', NUMERIC '200.00', 'Stand mixer')"
```

That leaves order 12345 at $165.85 over four line items, 12346 at $18.00, and
12347 at $200.00. Orders 12346 and 12347 are here to give the lookups something
to tell 12345 apart from; the request needs neither. To start over, drop the
database with the command under [Cleaning up](#cleaning-up) and run these four
again.

## 3. Check what the model declares

```console
$ ../../../dist/kcmd action list
Model 'commerce' (commerce_demo), profile 'spanner':
  store: my-project/my-instance/semantic_agent_demo
  IssueCredit: Credit a customer against one order -- a late delivery, a coupon, a shipping charge applied in error. The credit is added as a negative line and the order total is recomputed from the lines.
    parameters: order (Order, reference), amount (Decimal), memo (String)
    executor:   sql
    guards:     CreditWithinOrderTotal, CreditUnderReviewThreshold, CreditMemoNamesAServiceFailure, CreditIsNotSplitToAvoidReview
    affects:    LineItem (create), Order (modify)
    run:        kcmd action run IssueCredit --judge --judge-reads-store --arg order=<Order> --arg amount=<Decimal> --arg memo=<String>
```

The `run:` line names both judge flags because the guards are judged and the
model has tables under this profile to read, and a suggested command certain to
be refused is worse than no suggestion. Nothing in a constraint's wording says
whether settling it takes a look at the store, so the line offers the reading
judge wherever a read is possible, and a judge with nothing to look up looks
nothing up.

No warnings print above the listing. Every constraint the model declares is
named in `guards`, and every one of them is a rule this runtime can settle, so
there is nothing for the loader to report.

What the listing doesn't say is what the configuration costs. Each of those four
guards is a model call, at least — a guard that reads the store costs more than
one — and every call of `IssueCredit` pays for all four. The arithmetic is at
the end of this section.

The action runs from the command line before any agent exists. `--judge` hires
the judge, and `--judge-reads-store` is what lets it look at the tables the model
binds:

```console
$ ../../../dist/kcmd action run IssueCredit --judge --judge-reads-store --arg order=12346 --arg amount=3.00 --arg memo="Coupon applied late"
Running 'IssueCredit' on projects/my-project/instances/my-instance/databases/semantic_agent_demo...
  rules stated in words go to gemini-2.5-flash (us-central1)
  it may read commerce's tables to settle them
  the judge reads: SELECT total FROM Orders WHERE order_id = 12346
  order: '12346' -> Order 12346
Committed at 2026-09-14T19:12:04.996343Z.
```

Four judgments were put to Gemini and all four held, so the write went through.
One of them went and looked. Nothing in the call says what order 12346 totals, so
the judge settling `CreditWithinOrderTotal` wrote a statement, ran it, and
compared $3.00 against the $18.00 that came back. Nobody wrote that SQL: the
rule names the order's total in words, and the judge was told which tables hold
this model's data.

One verdict in that run does not repeat reliably. `Coupon applied late` gives a
cause without naming a thing that went wrong, which leaves it near the line
`CreditMemoNamesAServiceFailure` draws, and some runs settle that rule the other
way and print its advisory warning above the commit. The write lands either way,
because the rule is advisory. A judged rule is settled afresh for every call, so
a case close to the line a rule draws has no one fixed answer. That is a reason
to keep the cases a rule must catch well clear of its line.

`order=12346` was text; the runtime resolved it to a row and says which one. The
total moved from $18.00 to $15.00 with nobody doing arithmetic, because the
second statement recomputes it from the lines. Both statements ran in one
read-write transaction.

Ask for more than the order is worth and the same guard refuses:

```console
$ ../../../dist/kcmd action run IssueCredit --judge --judge-reads-store --arg order=12346 --arg amount=20.00 --arg memo="Shipping charge applied in error"
Running 'IssueCredit' on projects/my-project/instances/my-instance/databases/semantic_agent_demo...
  rules stated in words go to gemini-2.5-flash (us-central1)
  it may read commerce's tables to settle them
  the judge reads: SELECT total FROM Orders WHERE order_id = 12346
Error: Action 'IssueCredit' is guarded by 'CreditWithinOrderTotal' ("The credit amount
requested must not exceed the total of the order it is applied to. The `order` argument
of this call identifies that order, and the order's total is on record rather than
stated in the arguments, so read it before answering. Read both as dollars."), and
gemini-2.5-flash (us-central1) judged that it does not hold for this call: The credit
amount of 20.00 exceeds the order total of 15.00. The model marks this rule 'escalate',
so an approver may allow it; nothing here can. A credit cannot exceed the total of the
order it credits. Lower the credit amount, or split it across the orders it actually
covers. No transaction was opened, so nothing was written.
```

$15.00 is what the previous run left on the order, and the judge read the number
that is there now rather than the one this page seeded. $20 is under the
25-dollar ceiling, so no threshold rule catches it. What catches it is a
comparison against a row.

Drop `--judge-reads-store` and the judge knows only what it was passed. It does
not guess, and it does not quietly let the rule hold:

```console
$ ../../../dist/kcmd action run IssueCredit --judge --arg order=12346 --arg amount=3.00 --arg memo="Coupon applied late"
Running 'IssueCredit' on projects/my-project/instances/my-instance/databases/semantic_agent_demo...
Error: Action 'IssueCredit' is guarded by 'CreditWithinOrderTotal' ("The credit amount
requested must not exceed the total of the order it is applied to. ..."), and
gemini-2.5-flash (us-central1) judged that it does not hold for this call: I need to
know the total of order 12346 to compare it to the requested credit amount of $3.00. The
model marks this rule 'escalate', so an approver may allow it; nothing here can. A
credit cannot exceed the total of the order it credits. Lower the credit amount, or
split it across the orders it actually covers. No transaction was opened, so nothing was
written.
```

$3.00 would have passed. The rule went unsettled rather than violated, and an
unsettled rule counts as not holding — which is the whole reason the wording of a
judged rule and the capabilities of the judge have to be chosen together. A rule
that names something on record needs a judge that can read the record.

Drop `--judge` as well and nothing is put to anything, because the runtime will
not apply a write the model says must be checked when it has nothing to check
with:

```console
$ ../../../dist/kcmd action run IssueCredit --arg order=12346 --arg amount=3.00 --arg memo="Coupon applied late"
Running 'IssueCredit' on projects/my-project/instances/my-instance/databases/semantic_agent_demo...
Error: Action 'IssueCredit' is guarded by 'CreditWithinOrderTotal',
'CreditUnderReviewThreshold' and 'CreditIsNotSplitToAvoidReview', which are settled by
reading the call, and this runtime was given no judge to ask. Running it would apply a
write the model says must be checked first, so it is refused rather than run unchecked.
```

The advisory rule is absent from that list, and belongs absent: a `warn` rule
never stops a call, so a missing judge cannot make it stop one. Refusing on its
behalf would make a model that states advisory rules permanently unrunnable.

One credit landed out of those four calls. Read the orders back with plain SQL:

```console
$ gcloud spanner databases execute-sql semantic_agent_demo \
    --instance=my-instance --project=my-project \
    --sql="SELECT order_id, placed_on, total FROM Orders ORDER BY order_id"
order_id  placed_on   total
12345     2026-09-07  165.85
12346     2026-08-20  15
12347     2026-09-02  200
```

However the action is called, the order's total matches its lines.

### What a reading judge is allowed to do

Handing a database to a language model at the moment it decides whether a write
may proceed is worth being precise about. Four things constrain it, and one
limit survives all four.

**It is shown the model rather than the database.** The tables and columns in the
judge's system instruction are derived from the same binding profile the lookup
tools come from, so a column no lookup tool would return is a column no judge is
told exists. Under `spanner` the judge is shown this, and nothing else:

```
Write GoogleSQL. These tables are the whole of what you may read.

Customer
  table Customer
    customer_id is Customer.customerId, Integer
    name is Customer.name, String. The customer's display name, e.g. "Morgan Ellis".
    email is Customer.email, String

Order: A customer order. Its total is the sum of its line items: items, tax and fees add, credits subtract. A positive total is money owed to the company.
  table Orders
    order_id is Order.orderId, Integer
    customer_id is Order.customerId, Integer
    placed_on is Order.placedOn, Date. The day the order was placed.
    total is Order.total, Decimal. What the customer owes on this order, in dollars.
    status is Order.status, String. OPEN or CLOSED.

LineItem: One line of an order. A charge line is positive; a credit line is negative, so that the order total is always a plain sum.
  table LineItem
    line_item_id is LineItem.lineItemId, String
    order_id is LineItem.orderId, Integer
    type is LineItem.type, String. item, tax, fee, or credit.
    amount is LineItem.amount, Decimal
    memo is LineItem.memo, String
```

The `is` clauses are there because the rule is written about `Order.total` and
the statement has to be written about `Orders.total`. Under the `alloydb`
profile the same model produces `Write PostgreSQL`, `table "purchase_order"`,
and `"order_total" is Order.total` — so the judge writes the other dialect
against the other names, from the same sentence in `commerce.yaml`.

**Every statement is checked before it is sent.** It has to be a single command
beginning with `SELECT` or `WITH`. Comments and string literals are blanked out
before that check, so a `;` inside a quoted memo is not mistaken for the end of
one statement and the start of another.

**Every statement is wrapped.** What actually runs is

```sql
SELECT * FROM (
<whatever the judge wrote>
) AS judge_read LIMIT 21
```

and the wrap is the part carrying the weight, because the keyword check on its
own is not enough. `WITH gone AS (DELETE FROM order_line WHERE order_id = 12346
RETURNING *) SELECT * FROM gone` begins with `WITH` and deletes rows. Wrapped,
the database refuses it:

```console
$ psql "host=$PGHOST dbname=semantic_agent_demo" -c "SELECT * FROM (
WITH gone AS (DELETE FROM order_line WHERE order_id = 12346 RETURNING *)
SELECT * FROM gone
) AS judge_read LIMIT 21"
ERROR:  WITH clause containing a data-modifying statement must be at the top level
```

That refusal matters most on AlloyDB, where the store's query path runs in an
implicit transaction and a write reaching it would commit. On Spanner the read
path is a read-only transaction and could not write whatever was sent.

**Every read is printed, and every result is capped.** The `the judge reads:`
line is the audit record of a query the caller never asked for, so it goes to the
same place as the outcome. Twenty rows come back at most, each cell clipped, and
the judge is told when it is seeing a truncated answer.

What none of that changes is *when* the read happens. Guards settle before the
transaction opens, so the judge sees committed state and never the state the
write would produce, and two credits racing each other can each read a total that
neither of them will leave behind. That is the same limit every guard has, and a
rule that has to survive it belongs in the schema, where the store enforces it
inside the write.

**What a guarded call costs.** Reading is a conversation rather than a lookup:
the judge is asked, it may ask for rows, it is shown them, and only then does it
answer. So a guard that reads nothing costs two model calls, and each round of
reading adds one. The committed run above put four guards to Gemini, one of which
read once, for nine calls. Without `--judge-reads-store` the same four guards
cost four calls and the first of them cannot be settled.

## 4. Look at the tools before writing the agent

`kcmd agent tools` prints exactly what an agent will be handed, before there is
an API key, a language model, or a line of agent code. Ask it without a judge
first, because what an agent is offered depends on what it is holding:

```console
$ ../../../dist/kcmd agent tools
Model 'commerce' (commerce_demo), profile 'spanner':
  store: my-project/my-instance/semantic_agent_demo

  action  issue_credit  (IssueCredit)  [NOT RUNNABLE]
      Credit a customer against one order -- a late delivery, a coupon, a
      shipping charge applied in error. The credit is added as a negative line
      and the order total is recomputed from the lines.

      Give the order as its number, the amount in dollars, and a memo saying
      why. Look the order up first if you were given a customer name rather
      than a number: an Order is identified by its key alone. Say in the memo
      what actually went wrong on the order -- a late delivery, a damaged item,
      a shipping charge applied in error -- and, if this credit is part of a
      larger amount owed, say that and give the total. A rule reads the memo,
      so a fact left out of it is a fact the rule cannot weigh.

      This call is gated by CreditWithinOrderTotal, CreditUnderReviewThreshold
      and CreditIsNotSplitToAvoidReview:
      - CreditWithinOrderTotal: The credit amount requested must not exceed the
        total of the order it is applied to. The `order` argument of this call
        identifies that order, and the order's total is on record rather than
        stated in the arguments, so read it before answering. Read both as
        dollars. A credit cannot exceed the total of the order it credits.
        Lower the credit amount, or split it across the orders it actually
        covers.
      - CreditUnderReviewThreshold: The credit amount requested must not exceed
        25 dollars, which is the self-service ceiling for this desk. Read the
        amount as dollars. A credit over $25 is above the self-service ceiling.
        A supervisor decides it.
      - CreditIsNotSplitToAvoidReview: The credit requested must be the whole
        of what this order is owed, not one piece of a larger amount divided to
        stay under the 25-dollar self-service ceiling. A memo argument calling
        the credit a part, a half, an instalment, the first or second of
        several, or a remainder, or naming a total larger than the amount
        argument, does not satisfy this rule. Raise this as a single credit for
        the full amount and send it for supervisor review.

      Calling this will not work: Action 'IssueCredit' is guarded by
      'CreditWithinOrderTotal', 'CreditUnderReviewThreshold' and
      'CreditIsNotSplitToAvoidReview', which are settled by reading the call,
      and this runtime was given no judge to ask. Running it would apply a
      write the model says must be checked first, so it is refused rather than
      run unchecked. Report that rather than retrying.
      order: string -- Which Order this applies to. Give its key, or text that
          identifies exactly one; the call fails when nothing matches or more
          than one does.
      amount: number -- The amount, as a decimal number.
      memo: string -- The memo, as text.
```

Pass `--judge` and the same action is offerable, with the same description and
the same parameters, minus the refusal:

```console
$ ../../../dist/kcmd agent tools --judge
Rules stated in words go to gemini-2.5-flash (us-central1).
Model 'commerce' (commerce_demo), profile 'spanner':
  store: my-project/my-instance/semantic_agent_demo

  action  issue_credit  (IssueCredit)
      ...
      This call is gated by CreditWithinOrderTotal, CreditUnderReviewThreshold
      and CreditIsNotSplitToAvoidReview:
      - CreditWithinOrderTotal: The credit amount requested must not exceed the
        total of the order it is applied to. ...
      order: string -- Which Order this applies to. Give its key, or text that
          identifies exactly one; the call fails when nothing matches or more
          than one does.
      amount: number -- The amount, as a decimal number.
      memo: string -- The memo, as text.
```

Neither run calls a model. The derivation reports what the runtime *would* do
with the judge it holds, and finding that out costs nothing: a judge settles a
rule when an action runs rather than when a listing is printed. If it were
otherwise, reading this listing would bill you per guarded action.

The rest of the listing is the same either way:

```console
  lookup  find_customer  (Customer)
      Look up Customer records.

      Returns customerId, name, email. Every argument is an exact match and
      every one is optional; giving none returns the first rows. This tool
      cannot join, compare ranges, or total anything.
      customerId: integer
      name: string -- The customer's display name, e.g. "Morgan Ellis".
      email: string

  lookup  find_order  (Order)
      A customer order. Its total is the sum of its line items: items, tax and
      fees add, credits subtract. A positive total is money owed to the
      company.

      Returns orderId, customerId, placedOn, total, status. Every argument is
      an exact match and every one is optional; giving none returns the first
      rows. This tool cannot join, compare ranges, or total anything.
      orderId: integer
      customerId: integer
      placedOn: string -- The day the order was placed.
      total: number -- What the customer owes on this order, in dollars.
      status: string -- OPEN or CLOSED.

  lookup  find_line_item  (LineItem)
      One line of an order. A charge line is positive; a credit line is
      negative, so that the order total is always a plain sum.

      Returns lineItemId, orderId, type, amount, memo. Every argument is an
      exact match and every one is optional; giving none returns the first
      rows. This tool cannot join, compare ranges, or total anything.
      lineItemId: string
      orderId: integer
      type: string -- item, tax, fee, or credit.
      amount: number
      memo: string

  instruction:
      You are working an internal operations desk for this business, fixing
      orders on behalf of the people who run it. A request describes an order
      the way a person does -- a customer's name, a day, what went wrong -- so
      expect to be given a description where the model expects a number, and
      expect to have to read an order's lines to find out what was actually
      charged.

      Never invent an identifier. When you are given a name or a description
      instead of one, find it with the lookup tools rather than asking for it
      -- that is what they are for, and asking wastes the caller's time. Never
      compute a total or a balance yourself; the tools do that. When a tool
      reports that a write did not happen, read the reason it gives and repeat
      it plainly; if it says a person has to decide, say so and stop, because
      you cannot approve it yourself. When a write did happen and the tool
      returns warnings, the change landed and a rule still went unmet or
      unchecked: report both, because nobody else will. Finish by saying what
      you changed.
```

Every line of that came out of the model. The action's description and its
`ai_context.instructions` became the tool description; its typed parameters
became typed tool parameters; each entity's description and bound fields became
a lookup and its filters; the guards it names became the line that says what
gates the call. The instruction is the model's persona followed by the tool
contract the derivation itself defines.

Two sentences of that contract exist because a guard can now fire. "If it says a
person has to decide, say so and stop" is what `escalate` needs from a caller.
The sentence about warnings is what `warn` needs: a write that landed while a
rule went unmet is the one case where reporting the outcome alone would be a lie
by omission.

Look at `type: string -- item, tax, fee, or credit.` in particular. That line is
the field's description in `commerce.yaml`, and it is the only place a caller
can learn that a shipping charge is a `fee`. An earlier derivation dropped it
and wrote boilerplate instead, and the agent guessed `type: "shipping"`, got
nothing back, and spent a turn finding out. The fix went into `agent_tools.ts`
rather than into this demo, because every filter over a coded field had the same
hole, in every model.

The read tools are narrow by design — exact match on any bound field, ANDed,
capped, no joins, ranges or totals. That is enough to find the object an action
needs, and it keeps the generated SQL checkable by eye. When a lookup is not
enough, write a query rather than widening the tool.

## 5. Write the agent

Here is the whole agent: the five steps, with the framework's own API doing the
work:

```ts
// 1. Build the runtime kcmd builds -- the model paired with the store the
//    model says it lives in.
const runtimes = await createSemanticRuntimes({path: import.meta.dir});
if ('error' in runtimes) throw new Error(runtimes.error);
const [runtime] = runtimes;
if (!runtime.store) throw new Error(runtime.storeError);

// 2. Hire something that can settle a rule stated in words, and let it read
//    the model's own tables while it does.
const store = modelJudgeStore(runtime);
if ('error' in store) throw new Error(store.error);
const judge = new GeminiJudge(ApiContext.default(), {
  project: process.env.GOOGLE_CLOUD_PROJECT,
  location: process.env.GOOGLE_CLOUD_LOCATION,
  model: process.env.DEMO_JUDGE_MODEL,
  store,
});

// 3. Derive what the model offers, and keep what this binding can serve --
//    what `kcmd agent tools --judge` just printed.
const {callable, withheld, instruction} =
    callableTools(modelTools({runtime, judge}));
for (const tool of withheld) {
  console.error(`(withheld) ${tool.name}: ${tool.unavailable}`);
}

// 4. Adapt each one to ADK.
const tools = callable.map(
    tool => new FunctionTool({
      name: tool.name,
      description: tool.description,
      parameters: {
        type: Type.OBJECT,
        properties: Object.fromEntries(tool.parameters.map(p => [
          p.name, {type: p.type.toUpperCase() as Type, description: p.description}
        ])),
        required: tool.parameters.filter(p => p.required).map(p => p.name),
      },
      execute: (args: unknown) => tool.invoke(args as Record<string, unknown>),
    }));

// 5. Run.
const agent = new LlmAgent({
  name: 'model_agent',
  model: 'gemini-2.5-flash',
  instruction,
  tools,
});
```

Step 2 is eight lines and no policy. The judge is a capability, like the database
connection: it can settle a rule stated in words, and *which* rules it is asked
are the ones the model names in `guards`. Nothing here says 25 dollars, and
nothing here decides that a memo has to name a failure. Change the ceiling in
`commerce.yaml` and this file does not move.

`modelJudgeStore(runtime)` is the same kind of line. It says the judge may read;
the model and the profile say what, because the tables in
[the schema above](#what-a-reading-judge-is-allowed-to-do) are derived rather
than listed here. `agent.ts` passes an `onRead` callback as well, which is why
the transcripts below print each statement.

It may well be the same Gemini model the agent runs on, and it is not the same
call. The judge is asked one rule about one set of attempted arguments, under a
system instruction of its own, outside the agent's conversation. So the agent
never sees the exchange: there is nothing in the transcript for it to argue with,
and no turn in which it can talk the gate round.

The judge goes to the derivation rather than to each invocation, which is the
one non-obvious line in step 3. Whether a guarded action can be offered *at all*
depends on holding a judge, so the same object has to answer `runnable` and
answer the call. A tool derived with a judge and then invoked without one would
be advertised as callable and refused mid-call, which spends the agent's turn and
teaches it nothing.

Step 4 is the only part shaped by ADK rather than by the model, and all it does
is rename fields: a derived parameter already carries a JSON type and a
description, which is the whole of a function declaration. ADK takes a plain
schema object, so there is no schema library in here and nothing to keep in step
with the derivation's types.

Step 3 is one call because every adapter has to make the same split over
`[...lookups, ...actions]`. A tool the runtime cannot run is still worth naming,
yet offering it as callable spends a turn on a call that cannot succeed.
`callableTools` makes that split in the library, and returning `withheld`
separately means you have to choose to drop it silently.

What `agent.ts` adds to the sketch is the loop that prints each call and each
answer, the usage line, and one line appended to the instruction —

```ts
  instruction: `${instruction}\n\nToday is ${
      new Date().toISOString().slice(0, 10)}.`,
```

The request says "Labor Day" and the filter wants `2026-09-07`. Turning one into
the other needs a calendar, which a language model has, and a clock, which it
does not. Without that line the agent guesses a year, drops the filter and
scans, or stops to ask which date you meant — all three happened. With it, three
consecutive runs got `placedOn: "2026-09-07"` on the first try.

That line goes in the agent rather than the model on purpose. Today's date is a
fact about when the process runs rather than a fact about commerce, so
`commerce.yaml` would be wrong tomorrow. The boundary works the other way too:
the moment something about *this business* has to be written into `agent.ts`,
the model was missing it, and the fix belongs in the model.

## 6. Run it

The request below is phrased the way the person with the problem would phrase
it. ADK logs an `INFO` line per model call; the transcripts leave those out, and
the three load-time warnings from
[step 3](#3-check-what-the-model-declares) still print first.

```console
$ bun agent.ts "Find the order for Morgan Ellis (morgan.ellis@example.com) that was placed on Labor Day. It was supposed to get free shipping but we had a glitch and the customer got charged. Please issue them a credit to offset the charge."
  -> find_customer({"email":"morgan.ellis@example.com","name":"Morgan Ellis"})
  <- {"entity":"Customer","fields":["customerId","name","email"],"rows":[["1","Morgan Ellis","morgan.ellis@example.com"]],"truncated":false}
  -> find_order({"placedOn":"2026-09-07","customerId":1})
  <- {"entity":"Order","fields":["orderId","customerId","placedOn","total","status"],"rows":[["12345","1","2026-09-07","165.85","OPEN"]],"truncated":false}
  -> find_line_item({"orderId":12345})
  <- {"entity":"LineItem","fields":["lineItemId","orderId","type","amount","memo"],"rows":[["li-12345-1","12345","item","89.99","Cast iron skillet"],["li-12345-2","12345","item","34.5","Enamel saucepan"],["li-12345-3","12345","fee","30","Shipping"],["li-12345-4","12345","tax","11.36","Sales tax"]],"truncated":false}
  -> issue_credit({"memo":"Credit for shipping charge applied in error.","amount":30,"order":"12345"})
  (judge reads) SELECT total FROM Orders WHERE order_id = 12345
  <- {"applied":false,"reason":"Action 'IssueCredit' is guarded by 'CreditUnderReviewThreshold' (\"The credit amount requested must not exceed 25 dollars, which is the self-service ceiling for this desk. Read the amount as dollars.\"), and gemini-2.5-flash (us-central1) judged that it does not hold for this call: The credit amount of 30 dollars exceeds the self-service ceiling of 25 dollars. The model marks this rule 'escalate', so an approver may allow it; nothing here can. A credit over $25 is above the self-service ceiling. A supervisor decides it. No transaction was opened, so nothing was written.","whatToDo":"Correct what the reason describes, or report it. Nothing was written."}
The credit for $30 could not be issued. The reason given is that the credit amount exceeds the self-service ceiling of $25 for this desk. A supervisor needs to approve credits over $25. Nothing was written.
```

The agent made three tool calls before the write, and the request named none of
the things they took. A name and an email became a customer id; a holiday became
a date; "the customer got charged" became a line of type `fee`, found by reading
the order's lines rather than supplied. Nowhere does the agent decide *how* to
issue a credit — that is one call, and the model owns what it does.

One query in that transcript is not the agent's. `(judge reads) SELECT total FROM
Orders WHERE order_id = 12345` is the guard on the order total settling itself:
$30 against $165.85, which holds. The guard that refused is the next one, and it
needed no read, because 25 dollars is written into the rule.

Then it was told no, by a rule it had no part in writing, and it stopped. Order
12345 is untouched:

```console
$ gcloud spanner databases execute-sql semantic_agent_demo \
    --instance=my-instance --project=my-project \
    --sql="SELECT order_id, placed_on, total FROM Orders ORDER BY order_id"
order_id  placed_on   total
12345     2026-09-07  165.85
12346     2026-08-20  18
12347     2026-09-02  200
```

Four things in that refusal are worth separating, because each comes from a
different place. The rule's *name and words* are quoted from `commerce.yaml`, so
an operator reading the transcript can go and find the rule. The *reason* is the
judge's, and it is about this call rather than about the rule in general. "The
model marks this rule `escalate`, so an approver may allow it; nothing here can"
is the runtime distinguishing a rule that ends the matter from one a person could
still overrule. And "No transaction was opened, so nothing was written" is a
statement about timing: the guards are settled before the transaction opens, so a
refusal is not a rollback and there is nothing to reconcile.

The agent's own sentence adds nothing and invents nothing. That is the derived
instruction working — "read the reason it gives and repeat it plainly; if it says
a person has to decide, say so and stop".

## 7. The other two outcomes

`on_violation` carries three consequences, and the demo reaches all three. A
credit under the ceiling with a memo that names the failure passes every guard
and lands:

```console
$ bun agent.ts "Dana Reyes says the stand mixer on order 12347 turned up with a dented casing. She's keeping it. Give her 20 dollars back."
  -> issue_credit({"amount":20,"order":"12347","memo":"Credit for stand mixer with dented casing."})
  (judge reads) SELECT total FROM Orders WHERE order_id = 12347
  (judge reads) SELECT total FROM Orders WHERE order_id = 12347
  <- {"applied":true,"actedOn":{"order":["12347"]},"committedAt":"2026-09-14T19:11:16.355995Z"}
I have credited 20 dollars to order 12347 for the dented stand mixer.
```

Four judgments were asked and all four held, so the write went through and order
12347 is $180.00. Note that the agent called `issue_credit` directly: the request
named the order, so there was nothing to look up.

The same statement was read twice here, and once in the command-line run of
[step 3](#3-check-what-the-model-declares) with the same four guards. How many
reads a call costs is not fixed and is not declared anywhere: each guard is put
to the judge in a conversation of its own, and a judge reads when the rule it is
settling makes it want to. Budget for a range rather than a number.

A credit with no failure behind it trips the advisory rule, and `warn` means the
write lands anyway and says so:

```console
$ bun agent.ts "Dana Reyes is asking for a 5 dollar credit on order 12347. She didn't say anything was wrong with it, she just asked for one as a gesture. Please put it through."
  -> issue_credit({"amount":5,"memo":"Customer requested a $5 credit as a gesture.","order":"12347"})
  (judge reads) SELECT total FROM Orders WHERE order_id = 12347
  <- {"applied":true,"actedOn":{"order":["12347"]},"committedAt":"2026-09-14T19:11:33.409154Z","warnings":["'CreditMemoNamesAServiceFailure' (\"The memo argument of this call must name a specific thing that went wrong on the order: ...\") is advisory, and gemini-2.5-flash (us-central1) judged that it does not hold for this call: The memo \"Customer requested a $5 credit as a gesture.\" does not name a specific thing that went wrong with the order. It states the customer asked for it, which is not a service failure."]}
I issued a $5 credit to Dana Reyes for order 12347. The credit was applied, but I want to let you know that the system flagged a warning: the memo "Customer requested a $5 credit as a gesture" doesn't describe a specific service failure, which is usually required. However, the system decided to proceed with the credit despite this warning.
```

`applied: true` and a warning in the same answer is the case that is easy to
report badly. The write happened; a rule the model states went unmet; both are
true, and an agent that mentioned only the first would leave nobody to notice the
second. The derived instruction asks for both, and the agent gave both without
being told anything about credits.

This is the one request in the four that does not always reach the tool. In
about a quarter of the runs the agent reads the advisory rule out of the tool
description, decides a memo naming no failure would be improper, and declines
before calling anything. That is the agent's judgment rather than the model's:
`warn` is the model saying this write should land and be flagged, and an agent
that refuses instead has quietly made an advisory rule a blocking one. Nothing
in the runtime stops it, which is worth knowing before an advisory rule is
relied on to let work through.

A credit split to duck the ceiling is refused outright:

```console
$ bun agent.ts "Order 12345 for Morgan Ellis is owed 40 dollars for a cast iron skillet that arrived cracked. I can only do 25 at a time on this desk, so put through the first 20 now and I'll do the rest tomorrow."
  -> issue_credit({"memo":"Credit for a cracked cast iron skillet. This is the first of two payments, totaling $40.","order":"12345","amount":20})
  (judge reads) SELECT total FROM Orders WHERE order_id = 12345
  <- {"applied":false,"reason":"Action 'IssueCredit' is guarded by 'CreditIsNotSplitToAvoidReview' (\"The credit requested must be the whole of what this order is owed, not one piece of a larger amount divided to stay under the 25-dollar self-service ceiling. A memo argument calling the credit a part, a half, an instalment, the first or second of several, or a remainder, or naming a total larger than the amount argument, does not satisfy this rule.\"), and gemini-2.5-flash (us-central1) judged that it does not hold for this call: The memo states that this is the first of two payments and names a total larger than the amount, which violates the rule. Raise this as a single credit for the full amount and send it for supervisor review. No transaction was opened, so nothing was written.","whatToDo":"Correct what the reason describes, or report it. Nothing was written."}
I cannot issue a split credit. The credit must be for the full amount of $40 and will require a supervisor's review. No changes were made to the order.
```

$20 is within order 12345's $165.85 total and under the 25-dollar ceiling, and
the memo names a real failure, so the first three guards held. The fourth caught
it, and no arithmetic could have: nothing about `amount = 20` on order 12345 is
out of policy. What is out of policy is the *intent*, and the only evidence of it
is the sentence the caller wrote.

That run is also the one that shows the limit of judging. This rule is worded to
read the memo, so it fires only if the memo admits the split — and the first time
this demo was run, it did not. The agent wrote a memo that named the breakage and
nothing else, dropping the "first 20 of 40" framing that was right there in the
request, and the credit went through. The judge was not wrong; it was given
laundered evidence.

The fix went into the model rather than the agent, because the model is where
the rule lives:

```yaml
            ... and, if this credit is part of a larger amount owed, say that
            and give the total. A rule reads the memo, so a fact left out of it
            is a fact the rule cannot weigh.
```

With that clause in the action's `ai_context`, the agent volunteered "This is the
first of two payments, totaling $40" and the rule fired. A judged rule over
caller-supplied text is only as good as the caller's candour. It catches an
honest mistake and deters a casual one; it does not stop a caller who has decided
to get around it.

What would hold regardless is a rule about the credits already on the order
rather than about the sentence attached to this one. The judge can now reach
those rows, so such a rule is writable here — reword it to count what
`LineItem` already holds for this order, the way
`CreditWithinOrderTotal` counts the total. This demo does not, because
the point being made is the difference between evidence a caller supplies and
evidence a rule goes and gets.

## 8. Run the same agent against AlloyDB

Everything so far ran against Spanner. This step runs the same request against
AlloyDB, and the interesting part is the size of the change: one environment
variable on the command line, and one file that already exists in the repo.

`catalog/EntryGroups/commerce_demo/commerce.profiles/alloydb.yaml` is the second
binding profile. Put it beside `spanner.yaml` and the differences are the whole
of what moving databases costs:

| | `spanner` | `alloydb` |
| --- | --- | --- |
| deployment target | a property graph | a database, and no graph |
| the order table | `Orders` | `purchase_order` |
| the lines table | `LineItem` | `order_line` |
| `Order.total` binds to | `total` | `order_total` |
| dialect of the two statements | GoogleSQL | PostgreSQL |

`commerce.yaml` is the same bytes under both. So is `agent.ts`. So are the tools
the model derives — you can check that rather than take it:

```console
$ ../../../dist/kcmd agent tools --profile spanner > /tmp/spanner.txt
$ ../../../dist/kcmd agent tools --profile alloydb > /tmp/alloydb.txt
$ diff /tmp/spanner.txt /tmp/alloydb.txt
1,2c1,2
< Model 'commerce' (commerce_demo), profile 'spanner':
<   store: my-project/my-instance/semantic_agent_demo
---
> Model 'commerce' (commerce_demo), profile 'alloydb':
>   store: alloydb:my-project/us-central1/my-cluster/my-instance/semantic_agent_demo
```

Eighty-six of the eighty-eight lines are identical: four tool names, every
parameter, every description and the whole instruction. The two that differ are
the two that say which deployment this is. That is the claim, and the `diff` is
the proof.

### What AlloyDB needs that Spanner did not

AlloyDB has no data-plane REST API — there is no equivalent of
`spanner.googleapis.com/.../executeSql`. SQL reaches it over the PostgreSQL wire
protocol, which means a network path and a database user, and those are the two
things to set up:

* **Reachability.** The client asks the Admin API for the instance's address and
  connects to port 5432. From inside the instance's VPC that is its private IP
  and nothing else is needed. From a workstation outside it, set `ALLOYDB_HOST`
  to an address that reaches the instance — the public IP, or whatever forwards
  there. Enabling a public IP is not on its own enough: an AlloyDB instance is
  VPC-attached and so always has a private address, the client prefers it
  whenever it exists, and `ALLOYDB_HOST` is what says otherwise.
* **A database user.** The client authenticates as the IAM principal your
  application-default credentials belong to, using the access token as the
  password. That principal has to exist as an AlloyDB IAM user and hold
  privileges on the three tables. Set `ALLOYDB_USER` to override the name.

The caller also needs `alloydb.instances.get` on the cluster, to look up the
address and the cluster CA.

### Create the store

An AlloyDB cluster is the expensive object here and it bills from the moment it
exists, so read [Cleaning up](#cleaning-up) before you create one.

```bash
PG_PROJECT=my-project
PG_REGION=us-central1
PG_CLUSTER=my-cluster
PG_INSTANCE=my-instance

gcloud alloydb clusters create "$PG_CLUSTER" \
  --region="$PG_REGION" --project="$PG_PROJECT" \
  --password="$(openssl rand -base64 24)" --network=default

gcloud alloydb instances create "$PG_INSTANCE" \
  --cluster="$PG_CLUSTER" --region="$PG_REGION" --project="$PG_PROJECT" \
  --instance-type=PRIMARY --cpu-count=2 \
  --database-flags=alloydb.iam_authentication=on \
  --assign-inbound-public-ip=ASSIGN_IPV4
```

`alloydb.iam_authentication=on` is what lets the access token serve as the
password. Then register yourself as a database user:

```bash
gcloud alloydb users create "$(gcloud config get-value account)" \
  --cluster="$PG_CLUSTER" --region="$PG_REGION" --project="$PG_PROJECT" \
  --type=IAM_BASED
```

Create the database, apply the schema and seed the same rows. `psql` connects as
the built-in `postgres` user for this part, because creating a database and
granting privileges is administration rather than anything the model does:

```bash
PGHOST=$(gcloud alloydb instances describe "$PG_INSTANCE" \
  --cluster="$PG_CLUSTER" --region="$PG_REGION" --project="$PG_PROJECT" \
  --format='value(publicIpAddress)')

psql "host=$PGHOST user=postgres" -c "CREATE DATABASE semantic_agent_demo"
psql "host=$PGHOST user=postgres dbname=semantic_agent_demo" -f schema.alloydb.sql
```

The same two customers, three orders and six line items as
[step 2](#2-create-the-store), in the other schema's names:

```bash
psql "host=$PGHOST user=postgres dbname=semantic_agent_demo" <<'SQL'
INSERT INTO customer (customer_id, name, email) VALUES
  (1, 'Morgan Ellis', 'morgan.ellis@example.com'),
  (2, 'Dana Reyes', 'dana.reyes@example.com');

INSERT INTO purchase_order (order_id, customer_id, placed_on, order_total, status) VALUES
  (12345, 1, DATE '2026-09-07', 165.85, 'OPEN'),
  (12346, 1, DATE '2026-08-20',  18.00, 'OPEN'),
  (12347, 2, DATE '2026-09-02', 200.00, 'OPEN');

INSERT INTO order_line (line_item_id, order_id, type, amount, memo) VALUES
  ('li-12345-1', 12345, 'item',  89.99, 'Cast iron skillet'),
  ('li-12345-2', 12345, 'item',  34.50, 'Enamel saucepan'),
  ('li-12345-3', 12345, 'fee',   30.00, 'Shipping'),
  ('li-12345-4', 12345, 'tax',   11.36, 'Sales tax'),
  ('li-12346-1', 12346, 'item',  18.00, 'Silicone spatula set'),
  ('li-12347-1', 12347, 'item', 200.00, 'Stand mixer');
SQL

psql "host=$PGHOST user=postgres dbname=semantic_agent_demo" -c \
  "GRANT SELECT, INSERT, UPDATE ON customer, purchase_order, order_line
   TO \"$(gcloud config get-value account)\""
```

### There is no push

`kcmd push` deploys a property graph, and AlloyDB has no property-graph DDL for
one to land in. The `alloydb` profile's deployment target says so by naming a
database and stopping there, and a push under it refuses rather than doing
something approximate:

```console
$ ../../../dist/kcmd push --profile alloydb --validate-only
Error: model 'commerce' (commerce) deploymentTarget '//alloydb.googleapis.com/projects/my-project/locations/us-central1/clusters/my-cluster/instances/my-instance/databases/semantic_agent_demo' is an AlloyDB database, which a model runs against rather than deploys to; AlloyDB has no property graph for a push to publish. Push under a profile whose target is a BigQuery or Spanner Graph, and use this one to run actions against.
```

Nothing in this demo depended on the graph. The agent's tools are derived from
the model and the profile, and the action's statements go to the database
directly — so the run below works with no push at all. What you give up is the
graph itself: no `GRAPH_TABLE` queries and no catalog entry describing the
relationships. Push under `spanner` when you want that; the two profiles are not
exclusive, and a model can be published in one place and run in another.

### Run it

`DEMO_PROFILE` picks the profile, the same way `--profile` does for `kcmd`. The
request is the credit that lands in
[step 7](#7-the-other-two-outcomes), word for word:

```bash
# From outside the VPC, point the client at the address psql just used.
export ALLOYDB_HOST="$PGHOST"

DEMO_PROFILE=alloydb bun agent.ts "Dana Reyes says the stand mixer on order 12347 turned up with a dented casing. She's keeping it. Give her 20 dollars back."
```

The Labor Day request from [step 6](#6-run-it) is refused here for the reason it
is refused there, and the refusal is decided before a transaction opens, so it
never reaches the database. Exercising the far side takes a request that passes
every guard.

Check the result the same way, in the other dialect:

```bash
psql "host=$PGHOST user=postgres dbname=semantic_agent_demo" -c \
  "SELECT line_item_id, order_id, type, amount, memo
     FROM order_line WHERE order_id = 12347 ORDER BY type"
```

What that should show is a credit line of `-20.00` with a UUID key and
`purchase_order.order_total` down to `180.00` — the outcome of
[step 7](#7-the-other-two-outcomes), reached by different SQL against different
tables, from the same request through the same agent. The note at the end of
this section says which parts of it have been run against a real cluster and
which have not.

### The same action without the model in the loop

`kcmd action run` takes the action the agent would have called and calls it
directly, with the arguments spelled out instead of chosen. It is the whole of
the run below the agent — the connection, the entity reference, both statements
and the commit — so it is worth doing once on a new store before handing the
store to a model:

```console
$ ../../../dist/kcmd action run IssueCredit --profile alloydb --judge --judge-reads-store \
    --arg order=12345 --arg amount=20.00 --arg memo='Shipping charged in error'
Running 'IssueCredit' on projects/my-project/locations/us-central1/clusters/my-cluster/instances/my-instance/databases/semantic_agent_demo...
  rules stated in words go to gemini-2.5-flash (us-central1)
  it may read commerce's tables to settle them
  the judge reads: SELECT order_total FROM purchase_order WHERE order_id = 12345
  order: '12345' -> Order 12345
Committed at 2026-09-14T19:17:08.588Z.
```

The credit is $20 rather than the $30 that was charged, because $30 is over the
self-service ceiling and would be held for an approver on this store exactly as
it is on Spanner. Dropping `--judge` produces the refusal from
[step 3](#3-check-what-the-model-declares), word for word.

Compare the read with the one on Spanner. There, the judge wrote `SELECT total
FROM Orders`; here it wrote `SELECT order_total FROM purchase_order`, in the
other dialect against the other names. The rule it was settling is the same
sentence in the same file. What changed is the profile, which is what the judge
is shown the tables through — so the guard moves databases on the same terms the
action does.

The reading guard is also the one place this backend is visibly poorer. AlloyDB
returns rows without column names, so the judge is handed values and told nothing
about which column each came from. It settled the rule anyway, because the
statement it wrote selected one column and it knew which one it asked for.

Ask for more than the order is worth and the guard refuses here too:

```console
$ ../../../dist/kcmd action run IssueCredit --profile alloydb --judge --judge-reads-store \
    --arg order=12346 --arg amount=20.00 --arg memo='Shipping charged in error'
Running 'IssueCredit' on projects/my-project/locations/us-central1/clusters/my-cluster/instances/my-instance/databases/semantic_agent_demo...
  rules stated in words go to gemini-2.5-flash (us-central1)
  it may read commerce's tables to settle them
  the judge reads: SELECT order_total FROM purchase_order WHERE order_id = 12346
Error: Action 'IssueCredit' is guarded by 'CreditWithinOrderTotal' ("The credit amount
requested must not exceed the total of the order it is applied to. ..."), and
gemini-2.5-flash (us-central1) judged that it does not hold for this call: The credit
amount of $20.00 exceeds the order total of $18.00. ...
```

Guards are settled from the attempted call, and from whatever the judge read,
before any transaction opens. Which database is underneath makes no difference
to any of these outcomes.

`order: '12345' -> Order 12345` is the reference being resolved: the argument
arrives as text and the runtime reads the key back out of `purchase_order`
before either statement runs, so an order that does not exist is refused here
rather than silently updating nothing. Afterwards:

```console
$ psql "host=$PGHOST user=$(gcloud config get-value account) dbname=semantic_agent_demo" -c \
    "SELECT line_item_id, type, amount, memo FROM order_line
       WHERE order_id = 12345 ORDER BY line_item_id"
             line_item_id             |  type  | amount |           memo
--------------------------------------+--------+--------+---------------------------
 4189b9c4-5a7e-4314-8f10-429972231b24 | credit | -20.00 | Shipping charged in error
 li-12345-1                           | item   |  89.99 | Cast iron skillet
 li-12345-2                           | item   |  34.50 | Enamel saucepan
 li-12345-3                           | fee    |  30.00 | Shipping
 li-12345-4                           | tax    |  11.36 | Sales tax
(5 rows)
```

The key is a UUID. The INSERT writes it with `gen_random_uuid()`, so the new
row's key never passes through the call. `order_total` reads `145.85`,
recomputed from those five lines rather than adjusted by the credit amount.

> **What on this page is copied from a real run, and what is not.** Every `kcmd`
> listing here is, including the `diff` above, the push refusal, and the
> `action run` and `psql` output just above. Those two are from a live AlloyDB
> cluster, so the connection, the IAM token as the password, the cluster CA and
> the `@name`-to-`$1` rewrite are proven against a real database rather than only
> against unit tests. So are all four judged guards, the judge's own read, both
> statements and the commit. So is the refusal of the wrapped data-modifying CTE
> shown in [step 3](#what-a-reading-judge-is-allowed-to-do): that error came
> from this cluster, and the rows it tried to delete were still there
> afterwards. The **agent** transcript
> under `alloydb` is not captured: `@google/adk` does not install here, so the
> model-in-the-loop leg of this section has been run only under `spanner`. What
> that leg adds over `action run` is the model choosing the action and its
> arguments, and `kcmd agent tools` shows it is offered the same two lines of
> difference either way. One edit postdates every run on this page. Under both
> profiles the INSERT keyed the new row from a runtime-generated UUID when these
> outputs were captured, and it now generates one inside the statement instead,
> with `GENERATE_UUID()` under `spanner` and `gen_random_uuid()` under
> `alloydb`. Any key shown above is still a UUID, but neither statement as it
> stands has been sent to its store.

## What in here is about ecommerce

Four files carry the business, and you can list them:

| File | What it holds |
| --- | --- |
| `catalog/EntryGroups/commerce_demo/commerce.yaml` | the ontology, the action, the six policy rules, the persona |
| `catalog/.../commerce.profiles/spanner.yaml` | tables, columns, the two SQL statements, the deployment target |
| `catalog/.../commerce.profiles/alloydb.yaml` | the same four things, for the other database |
| `schema.spanner.sql`, `schema.alloydb.sql` | three `CREATE TABLE`s, twice |
| the seed commands in [step 2](#2-create-the-store) and [step 8](#8-run-the-same-agent-against-alloydb) | two customers, three orders, six lines |

`agent.ts` is not on that list, and neither is anything under `src/`. Swap those
files for a different business and the same 72 lines run it. That is the claim
this demo makes, and the file list is how you check it.

Note which rows doubled and which did not. Moving to a second database added a
profile and a schema; it added no entity, no field, no action, no rule and no
line of agent code.

The list stayed short because of three decisions, and each put a fact in a
different place. This case wanted a filter over a coded field, and the fix went
into `agent_tools.ts`, where it helps every model, rather than into a
hand-written tool here. It wanted today's date, and that went into `agent.ts`
because it is a fact about the run rather than about commerce. And it wanted
callers to disclose a split credit, which went into `commerce.yaml` because it
is a fact about this desk's policy. Each new use case pushes on the boundary in
one of those three
directions, and the useful question is always which.

## What is not wired up yet

**Arithmetic is settled by a model.** A constraint's rule is words, so the
25-dollar ceiling and the comparison against the order total are both
subtractions that cost a model call here and can answer two identical calls
differently. See
[what a judgment costs](../../../docs/semantic-model/actions.md#what-a-judgment-costs).

**A judge reads committed state rather than the state the write would produce.**
Guards settle before the transaction opens, so that a model call does not hold
write locks, and the read inherits that timing. Two credits racing each other can
each read a total that neither of them will leave behind, and both can pass. A
rule of this shape is only as good as the gap between the read and the commit.
A rule that has to hold under concurrency wants to be enforced inside the write,
which is your schema's job rather than a guard's.

**Stored text reaches the judge.** A rule worded to read a memo column would be
reading text a customer or an agent wrote, inside the prompt that decides whether
a write proceeds. The judge is told to compose every statement itself and never
to treat a value it read back as an instruction, results are capped and clipped,
and every statement is printed. None of that is a guarantee. Word a rule to read
numbers and keys where you can.

**A rule about the result of a write has nowhere to run.** That an order's total
equals the sum of its lines is such a rule: it constrains the state the write
leaves behind, and guards are settled before the write. A store-reading judge
does not fix it, because the problem is when the check runs rather than what it
can see. Such a rule wants to be checked inside the transaction or declared in
the schema, and this runtime offers neither binding point — which is why
`commerce.yaml` leaves the rule out and says where it belongs.

**Every gate costs model calls, and reading costs more of them.** Four guards
means four conversations with Gemini before a write, run one after another. A
judge that cannot read spends one call per guard; a judge that can spends two,
plus one for every round of reading, because it has to be shown its rows before
it can say whether it wants more. The committed run in
[step 3](#3-check-what-the-model-declares) cost nine. The runtime stops at the
first refusal, so a call that is going to be rejected does not pay for the rest,
and a call that succeeds pays for every guard. Two of these four rules are
arithmetic, and a computed body would take them to zero — that is what the one
body costs, on every call.

**`escalate` still has nobody to escalate to.** The rung is now visible rather
than missing: the runtime recognises `escalate`, holds the write, and says in the
refusal that an approver could allow it and that nothing here can. What does not
exist is the approver — a queue, a second caller with a different mandate,
anything that could take the held call and say yes. Today `escalate` and `reject`
both stop the write; the difference is only in what the caller is told.

**A judged rule sees what its wording asks for.** Covered in
[step 7](#7-the-other-two-outcomes): `CreditIsNotSplitToAvoidReview` is worded
about the memo, so it fires because the model tells callers to disclose a split,
and nothing verifies that they did. Rewording it to count the credits already on
the order is possible now that a judge can read, and is not done here.

**Access control.** A business that runs an internal desk agent usually wants a
customer-facing one too, restricted to the caller's own orders. That needs the
caller's identity passed in the tool call and checked below the agent. Only the
internal one is here: the lookups take no caller identity and there is nothing to
scope them by, so the second agent cannot be built from this model today.

## Cleaning up

One command removes it all, because everything the demo made is in the database
the model names.

```bash
gcloud spanner databases delete "$DATABASE" \
  --instance="$INSTANCE" --project="$PROJECT"
```

If you also ran step 8, the AlloyDB cluster is the expensive half and goes
separately. It bills while it exists, so delete it rather than leaving it idle.

```bash
gcloud alloydb clusters delete "$PG_CLUSTER" \
  --region="$PG_REGION" --project="$PG_PROJECT" --force
```
