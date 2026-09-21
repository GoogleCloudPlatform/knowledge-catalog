# Generate an Agent Skill from a semantic model

A semantic model says what a business is, what may be done to it, and under what
rules. This demo takes one such model and turns it into an
[Agent Skill](https://agentskills.io) — a folder of Markdown that a coding agent
reads — with one command:

```bash
kcmd skills-generate
```

Then it installs that folder into a harness and gives the harness a support
request in English. The harness finds the right order, tries to fix it, and is
either allowed to or is refused, by rules that live in the model rather than in
the harness.

There is no agent in this directory. Nothing here is written against a
particular framework, and nothing here has to be rewritten to move to another
one. The skill is a folder of Markdown, and the rules are stated in the model
underneath it whatever reads it.

One thing to know before you start, because the rest of this page depends on
it: **`kcmd` compiles the model and generates the skill, and does not ship an
action runner or a rule judge.** Enforcing an action's guards before opening a
transaction is the job of the calling agent or a third-party tool framework
that wraps the action. Where that matters, this page says so, and the
transcripts recorded against the earlier CLI action runner are marked as such.

## What this demo is arguing

An agent that can change a business is mostly not code. It is a description of
the business, a list of what may be done to it, and the conditions under which
each of those things is allowed. Written as an agent, all three end up inside a
prompt and a set of hand-written tools — which means they are true of that one
agent, they drift when the business changes, and the rules can be edited by
whoever owns the agent rather than whoever owns the business.

Written as a semantic model, all three are declarations. The skill is derived
from them. So:

- **The skill is generated, not written.** Change the model, regenerate. There
  is no second copy of the business to keep in step.
- **The rules are stated once, in the model.** The skill renders them so the
  reading agent (or a third-party tool framework wrapping the action) knows
  what gates the write. Because `kcmd` does not ship an action runner or a
  judge, nothing in this repository enforces those rules outside the agent: an
  agent that runs statements directly against the database and ignores the
  skill's instructions gets past them unless a third-party tool framework
  mediates the write.
- **Any harness will do.** The output is the published Agent Skill layout, so
  Claude Code, Gemini CLI, Cursor and the other clients that read that layout
  all take it as-is.

## What you need

- `kcmd`, built from this repository: `npm install && npm run build` in
  `toolbox/mdcode`, which leaves the binary at `dist/kcmd`. Put it on your
  `PATH`.
- A Google Cloud project with Spanner and Vertex AI enabled, and
  `gcloud auth application-default login` done.
- A Spanner instance to create a database on.
- A coding agent that reads Agent Skills. The transcripts below are Claude Code
  and Gemini CLI, both headless; the install table covers the others.

Commands below use `my-project` and `my-instance`. Substitute your own, in these
commands and in `catalog/EntryGroups/commerce_demo/commerce.profiles/spanner.yaml`.

```bash
export PROJECT=my-project
export INSTANCE=my-instance
export DATABASE=semantic_skill_demo
export GOOGLE_CLOUD_PROJECT="$PROJECT"
export GOOGLE_CLOUD_LOCATION=us-central1
```

## 1. The model

`catalog/EntryGroups/commerce_demo/commerce.yaml` is the whole business: a small
ecommerce operation with customers, orders, and the lines that make up an order.
Read the file — it is commented — but these are the parts the rest of the demo
turns on.

**Three entities**, in the names the business uses. `Order`, not `Orders`;
`LineItem.lineItemId`, not `line_item_id`. Field descriptions are part of the
model, because they are facts about the business rather than notes to a
developer:

```yaml
- name: Order
  description: >-
    A customer order. Its total is the sum of its line items: items, tax
    and fees add, credits subtract. A positive total is money owed to the
    company.
  primary_key: [orderId]
  fields:
    - name: orderId
      datatype: Integer
      description: >-
        The order's number, which is how both the customer and the desk
        refer to it.
    - {name: customerId, datatype: Integer}
    - name: placedOn
      datatype: Date
      description: The day the order was placed.
    - name: total
      datatype: Decimal
      description: What the customer owes on this order, in dollars.
    - {name: status, datatype: String, description: OPEN or CLOSED.}
```

**One action.** `IssueCredit` credits a customer against one order. Its first
parameter is projected out of the model rather than declared here — `order` is
`Order.orderId`, so its type and its wording come from the entity and are
written down once — and `affects` says what the call reaches, for a reader who
does not have the SQL:

```yaml
- name: IssueCredit
  description: >-
    Credit a customer against one order -- a late delivery, a coupon, a
    shipping charge applied in error. The credit is added as a negative
    line and the order total is recomputed from the lines.
  parameters:
    - {name: order, concept: Order, field: orderId}
    - {name: amount, type: Decimal}
    - {name: memo, type: String}
  affects:
    - {concept: LineItem, operation: create, fields: [type, amount, memo]}
    - {concept: Order, operation: modify, fields: [total]}
  guards:
    - CreditWithinOrderTotal
    - CreditUnderReviewThreshold
    - CreditMemoNamesAServiceFailure
    - CreditIsNotSplitToAvoidReview
```

**Four rules, written in words.** A constraint carries a `judgment`, which a
language model settles against the attempted call. `on_violation` says what
happens when it does not hold, and the three values in play here are all
different things:

```yaml
- name: CreditUnderReviewThreshold
  judgment: >-
    The credit amount requested must not exceed 25 dollars, which is the
    self-service ceiling for this desk. Read the amount as dollars.
  on_violation: escalate
  description: >-
    A credit over $25 is above the self-service ceiling. A supervisor
    decides it.

- name: CreditMemoNamesAServiceFailure
  judgment: >-
    The memo argument of this call must name a specific thing that went
    wrong on the order: a late delivery, a damaged item, a shipping
    charge applied in error. A memo saying only that the customer asked,
    or that the credit is goodwill, or giving no reason at all, names no
    failure and does not satisfy this rule.
  on_violation: warn
  description: >-
    Say in the credit memo what actually went wrong with the order.

- name: CreditIsNotSplitToAvoidReview
  judgment: >-
    The credit requested must be the whole of what this order is owed,
    not one piece of a larger amount divided to stay under the 25-dollar
    self-service ceiling. A memo argument calling the credit a part, a
    half, an instalment, the first or second of several, or a remainder,
    or naming a total larger than the amount argument, does not satisfy
    this rule.
  on_violation: reject
  description: >-
    Raise this as a single credit for the full amount and send it for
    supervisor review.
```

`escalate` means a person could allow it but nothing automatic can. `warn` lets
the write through and reports. `reject` is a flat no. The fourth rule,
`CreditWithinOrderTotal`, is about a number that is in the database rather than
in the call. A judge is shown the arguments and nothing else, so that one is
recorded here and settled by nothing — see [Limits](#10-limits).

A constraint is inert until something references it. `guards:` on the action is
what gives these four effect; a constraint nobody names is documentation.

**Nothing above says where the data lives.** No table, no column, no SQL. Those
are physical facts and they are in `commerce.profiles/`.

## 2. The binding profiles

`commerce.profiles/spanner.yaml` maps the model onto a Spanner database. It may
not add an entity, rename a field or change what anything means — the loader
rejects that — so the whole of what is deployment-specific is in this one file:

```yaml
- name: Order
  source: //spanner.googleapis.com/projects/my-project/instances/my-instance/databases/semantic_skill_demo/tables/Orders
  fields:
    - {name: orderId, expression: order_id}
    - {name: total, expression: total}
```

and the SQL that carries the action out:

```yaml
- name: IssueCredit
  executor:
    sql:
      statements:
        - >-
          INSERT INTO LineItem (line_item_id, order_id, type, amount, memo)
          VALUES (GENERATE_UUID(), @order, 'credit', -@amount, @memo)
        - >-
          UPDATE Orders SET total = (
            SELECT COALESCE(SUM(li.amount), 0)
            FROM LineItem AS li
            WHERE li.order_id = @order
          ) WHERE order_id = @order
```

The total is recomputed from the lines rather than adjusted by the credit
amount, so the order cannot stop adding up however the action is called, and
there is no arithmetic for a reading agent to get wrong.

`commerce.profiles/alloydb.yaml` is a second profile over the same model:
different tables (`purchase_order`, `order_line`), one differently named column
(`order_total`), and PostgreSQL in place of GoogleSQL. `commerce.yaml` is the
same bytes under both. [Section 8](#9-the-same-skill-against-a-different-database)
generates the skill under it and diffs the two.

`catalog.yaml` picks which one is in force by default:

```yaml
scope: semantic-model.my-project.us-central1.commerce_demo
default_profile: spanner
```

## 3. Create the store

The tables exist before the model is pushed; `schema.spanner.sql` holds them.

```bash
gcloud spanner databases create "$DATABASE" \
  --instance="$INSTANCE" --project="$PROJECT" \
  --ddl-file=schema.spanner.sql
```

Seed it:

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

That leaves order 12345 at $165.85 over four line items — including a $30
shipping fee, which is what the first request below is about — 12346 at $18.00,
and 12347 at $200.00. The two extra orders give a query something to tell
12345 apart from.

Every number quoted in this README came from a run against exactly this seed. To
start over, drop the database with the command under [Cleaning
up](#11-cleaning-up) and create and seed it again.

## 4. Check what the profile binds

Before generating the skill, check that the profile binds the model to your
store. Run this from this directory, the one holding `catalog.yaml`:

```console
$ kcmd profiles
Model 'commerce' (commerce_demo):
  spanner  (default)
    target: spanner:my-project/my-instance/semantic_skill_demo
    entities: Customer, Order, LineItem
    actions: IssueCredit (sql)
```

### What the rules caught, when something was settling them

> These four were recorded when `kcmd` shipped a CLI action runner (`kcmd action
> run`) that took a judge and could give that judge the store to read. That
> command has been removed and no judge reads a store any more — the seam for it
> was taken out of the runtime. They are pasted as they were rather than
> corrected, because a transcript that was never printed is not evidence of
> anything.
> They are kept because what they show — one action, four rules, and every
> one of the three `on_violation` outcomes — is not shown anywhere else.

Without the store, `CreditWithinOrderTotal` is a rule about a number the judge
cannot see:

```console
$ kcmd action run IssueCredit --judge \
    --arg order=12346 --arg amount=3.00 --arg memo="Coupon applied late"
Running 'IssueCredit' on projects/my-project/instances/my-instance/databases/semantic_skill_demo...
  rules stated in words go to gemini-2.5-flash (us-central1)
Error: Action 'IssueCredit' is guarded by 'CreditWithinOrderTotal' ("The credit amount requested must not exceed the total of the order it is applied to. ..."), and gemini-2.5-flash (us-central1) judged that it does not hold for this call: The order total for order 12346 is not provided, so it's not possible to determine if the credit amount of $3.00 exceeds it. ...
```

Order 12346's total is $18.00 and a $3.00 credit against it is fine. The judge
could not say so, because it had a rule about a number and no way to see the
number. What it does instead is not predictable: this run said it could not
tell, and an earlier run of the same call answered that $3.00 exceeded a total
of $2.50 — a figure nothing in the database supports. A judge that cannot read
either blocks a call it should pass or invents the fact it was missing, and you
do not get to choose which. **That is what this rule does today**, and it is why
a rule about a stored number belongs in the schema rather than in a judgment.
Back when a judge could read, the same call looked like this:

```console
$ kcmd action run IssueCredit --judge --judge-reads-store \
    --arg order=12346 --arg amount=20.00 --arg memo="Shipping charge applied in error"
Running 'IssueCredit' on projects/my-project/instances/my-instance/databases/semantic_skill_demo...
  rules stated in words go to gemini-2.5-flash (us-central1)
  it may read commerce's tables to settle them
  the judge reads: SELECT total FROM Orders WHERE order_id = 12346
Error: Action 'IssueCredit' is guarded by 'CreditWithinOrderTotal' (...), and gemini-2.5-flash (us-central1) judged that it does not hold for this call: The credit amount of 20.00 exceeds the order total of 18.00. Please request a credit amount that does not exceed the order total. The model marks this rule 'escalate', so an approver may allow it; nothing here can. A credit cannot exceed the total of the order it credits. Lower the credit amount, or split it across the orders it actually covers. No transaction was opened, so nothing was written.
```

When a judge could read the store, it wrote its own `SELECT`, from the model,
and refused against the real total. What survives the seam's removal is the rest
of that message: which rule, the rule's own words, the judge's reason, the
consequence the model attaches, the advice the model wrote for this case, and
the fact that nothing was written. That whole message is what a reading agent
gets back, for every rule a judge can still settle.

Handed no judge at all, the runtime fails closed rather than writing unchecked:

```console
$ kcmd action run IssueCredit \
    --arg order=12346 --arg amount=3.00 --arg memo="Coupon applied late"
Error: Action 'IssueCredit' is guarded by 'CreditWithinOrderTotal', 'CreditUnderReviewThreshold' and 'CreditIsNotSplitToAvoidReview', which are settled by reading the call, and this runtime was given no judge to ask. Running it would apply a write the model says must be checked first, so it is refused rather than run unchecked.
```

That refusal is still the runtime's behaviour for any caller that supplies no
judge: rather than applying a write the model says must be checked first, it
stops before a transaction opens.

And the `reject` consequence, the one an approver cannot wave through:

```console
$ kcmd action run IssueCredit --judge --judge-reads-store \
    --arg order=12345 --arg amount=15.00 \
    --arg memo="First half of the 30 dollar shipping refund; the rest to follow"
Running 'IssueCredit' on projects/my-project/instances/my-instance/databases/semantic_skill_demo...
  rules stated in words go to gemini-2.5-flash (us-central1)
  it may read commerce's tables to settle them
  the judge reads: SELECT total FROM Orders WHERE order_id = 12345
Error: Action 'IssueCredit' is guarded by 'CreditIsNotSplitToAvoidReview' (...), and gemini-2.5-flash (us-central1) judged that it does not hold for this call: Your memo "First half of the 30 dollar shipping refund; the rest to follow" indicates that this credit is only part of a larger amount, which violates the rule. Raise this as a single credit for the full amount and send it for supervisor review. No transaction was opened, so nothing was written.
```

$15 is under every numeric ceiling in the model. What the rule caught is the
memo saying what the $15 is for.

Every rule is settled before a transaction opens, which is why each of these
says nothing was written. A refusal is not a rollback, and no rule ever sees the
write it gates.

## 5. Generate the skill

```console
$ kcmd skills-generate
Wrote skills/commerce/SKILL.md
Wrote skills/commerce/references/issue-credit.md
```

Flags:

```
--out <dir>       Directory to write the skill directories under; each skill takes a directory of its own, named after the skill. Defaults to `skills`
--name <name>     Name the skill, and so its directory; lowercase letters, digits and single hyphens. Defaults to the model's own name. Applies only to a scope with one model
--profile [name]  Read the model under this binding profile, which is what the skill's one deployment-specific section describes; defaults to default_profile, else the inline bindings
--force           Replace a skill that is already there, including deleting a reference file for an action the model no longer declares
```

### What came out

`SKILL.md` is a router. Its frontmatter is all a harness loads at startup, so it
has to be enough to decide whether to read further:

```yaml
---
name: "commerce"
description: "Customers, their orders, and the lines that make up an order. Declares 1 action: IssueCredit. Use when a request asks to change this data rather than only read it."
---
```

The body opens with the action table, one row per action, each pointing at its
own reference page:

```markdown
| Action | What it does | Reference |
| --- | --- | --- |
| `IssueCredit` | Credit a customer against one order -- a late delivery, a coupon, a shipping charge applied in error. The credit is added as a negative line and the order total is recomputed from the lines. | `references/issue-credit.md` |
```

Then **How this model wants to be used**, which is the model's own `ai_context`
followed by a paragraph derived from the fact that these are guarded writes —
what to do with a refusal, what to do with a warning, not to invent identifiers.
The model supplies what is specific to this business; the derivation supplies
what is true of guarded actions in general, so the model does not have to repeat
it.

Then **Finding a record**. This is the part worth dwelling on, because a skill of
writes has an obvious hole in it: a request names a person and a day, and the
action wants a key. The section opens by saying what a wrong key costs:

> A key that matches no record costs you the call rather than the data: a
> statement that writes no rows fails the action and rolls the whole transaction
> back, so nothing is half-applied and nothing is silently skipped. Guessing a
> key is therefore safe to be wrong about, and not safe to be right about by
> accident.

Then the generator emits the read path — the `gcloud` line for this store, and
the schema to write SQL against:

````markdown
To read the store directly:

```bash
gcloud spanner databases execute-sql semantic_skill_demo \
  --instance=my-instance --project=my-project \
  --sql='SELECT ...'
```

Those are GoogleSQL statements. These tables are the whole of what there is to read, and the names to write in a statement are the table and column names below -- not the model's own names, which follow each column for cross-reference:

```
Customer -> table Customer
  column customer_id (Integer) = Customer.customerId
  column name (String) = Customer.name. The customer's display name, e.g. "Morgan Ellis".
  column email (String) = Customer.email
Order -> table Orders
  column order_id (Integer) = Order.orderId. The order's number, which is how both the customer and the desk refer to it.
  column customer_id (Integer) = Order.customerId
  column placed_on (Date) = Order.placedOn. The day the order was placed.
  column total (Decimal) = Order.total. What the customer owes on this order, in dollars.
  column status (String) = Order.status. OPEN or CLOSED.
LineItem -> table LineItem
  column line_item_id (String) = LineItem.lineItemId
  column order_id (Integer) = LineItem.orderId
  column type (String) = LineItem.type. item, tax, fee, or credit.
  column amount (Decimal) = LineItem.amount
  column memo (String) = LineItem.memo
```
````

Both names are there and which is which is spelled out, because a harness has to
cross between them: the rest of the skill talks about `Order.total` and a
`SELECT` has to say `total`. The field descriptions come along because they carry
what a coded column's values actually are — `item, tax, fee, or credit` — and an
agent that guesses filters on a value the column never holds and gets an empty
answer back, which reads like the record not existing.

Then **Running an action**, the one deployment-specific section, which names the
bound store and executor and advises how an external agent framework should
wrap the actions as tools (since `kcmd` itself only emits the skill):

```markdown
Everything above is true of this model wherever it is deployed. This section is not: it describes the binding this skill was generated from, which is profile `spanner`.

- Store: `my-project/my-instance/semantic_skill_demo`
- Executor: `sql`

An agent that runs continuously should be handed these actions as tools by its own framework, which puts the action's guards to a judge before opening a transaction, and refuses rather than writing unchecked when it cannot settle one the model requires.
```

Then **What happens when you call one** — the three states a call comes back in,
and the fourth case that is not a state:

> A call can also come back applied **and** carry warnings. That means the change
> landed and a rule still went unmet, or went unchecked. Report both. Reporting
> only the success tells the caller the write met every rule the model states,
> which is the one thing it did not.

`references/issue-credit.md` is the page for the action: an argument table, the
model's `ai_context` for this action, each of the four rules with its `judgment`
verbatim, its `on_violation`, and the advice for when it does not hold, and last
the `affects` table. The reading agent gets the rules before it calls, in the
words that will be used to judge it.

## 6. Install it into a harness

The output is the published [Agent Skill](https://agentskills.io) layout: a
directory named for the skill, holding `SKILL.md` and `references/`. Installing
it means putting that directory where the harness looks.

Point `--out` straight at the directory your harness reads:

| Harness | Project-scoped | User-scoped |
| --- | --- | --- |
| Claude Code | `.claude/skills/` | `~/.claude/skills/` |
| Gemini CLI | `.agents/skills/` or `.gemini/skills/` | `~/.agents/skills/` or `~/.gemini/skills/` |
| Cursor | `.agents/skills/` or `.cursor/skills/` | `~/.agents/skills/` or `~/.cursor/skills/` |

`.agents/skills/` is the cross-tool location — Gemini CLI and Cursor both read
it, and Cursor additionally reads `.claude/skills/` and `.codex/skills/`.
agentskills.io lists the other clients that take the same layout. Two of these
are run below, against the same generated bytes; the rest of the table is from
each tool's documentation. So:

```bash
kcmd skills-generate --out .claude/skills --force
```

writes `.claude/skills/commerce/SKILL.md` and
`.claude/skills/commerce/references/issue-credit.md`, and Claude Code started in
this directory will offer the skill.

## 7. Run it

Everything below is a real run: Claude Code, headless, started in this
directory, with the skill installed at `.claude/skills/commerce/` and no other
instructions. The tools it was allowed are `kcmd`, `gcloud spanner databases
execute-sql`, and file reads. It was given no order numbers, no table names and
no SQL.

The four runs are consecutive against the seed from [section 3](#3-create-the-store),
so the state each one starts from is the state the previous one left.

> **These four were recorded when the skill carried a
> `kcmd action run ... --judge --judge-reads-store` command line, and they are
> kept because nothing else shows an agent meeting a rule it cannot talk its way
> past.**
> That command and those flags have since been removed, and no judge reads a
> store any more — the seam for it was taken out of the runtime. Read them for
> what the agent did with a refusal, not as what the CLI runs today.

### A request that gets refused

> Morgan Ellis emailed about the order she placed on Labor Day. She was charged
> for shipping and that order was supposed to ship free. Please put it right.

No order number, no amount, and the day is a holiday rather than a date. The
harness read the skill, read the reference page, and went looking:

```sql
SELECT c.customer_id, c.name, c.email, o.order_id, o.placed_on, o.total, o.status
FROM Customer c JOIN Orders o ON o.customer_id = c.customer_id
WHERE c.name = "Morgan Ellis" ORDER BY o.placed_on
```

```
customer_id  name          email                     order_id  placed_on   total   status
1            Morgan Ellis  morgan.ellis@example.com  12346     2026-08-20  18      OPEN
1            Morgan Ellis  morgan.ellis@example.com  12345     2026-09-07  165.85  OPEN
```

> Order 12345 was placed 2026-09-07 — Labor Day. Let me read its lines.

```
line_item_id  type  amount  memo
li-12345-1    item  89.99   Cast iron skillet
li-12345-2    item  34.5    Enamel saucepan
li-12345-3    fee   30      Shipping
li-12345-4    tax   11.36   Sales tax
```

> Shipping was charged $30 on an order that should have shipped free. The full
> amount owed is $30 — over the desk's $25 self-service ceiling, and the rules
> forbid splitting it to get under. I'll raise it as one credit for the full
> amount.

```console
$ kcmd action run IssueCredit --profile spanner --judge --judge-reads-store \
    --arg order=12345 --arg amount=30 \
    --arg memo='Shipping fee of $30.00 was charged in error on this Labor Day order; the order was supposed to ship free. Refunding the shipping charge in full.'
Running 'IssueCredit' on projects/my-project/instances/my-instance/databases/semantic_skill_demo...
  rules stated in words go to gemini-2.5-flash (us-central1)
  it may read commerce's tables to settle them
  the judge reads: SELECT total FROM Orders WHERE order_id = 12345
Error: Action 'IssueCredit' is guarded by 'CreditUnderReviewThreshold' (...), and gemini-2.5-flash (us-central1) judged that it does not hold for this call: The credit amount of 30 dollars exceeds the self-service ceiling of 25 dollars. The model marks this rule 'escalate', so an approver may allow it; nothing here can. A credit over $25 is above the self-service ceiling. A supervisor decides it. No transaction was opened, so nothing was written.
```

Its report:

> **Refused — this one needs a supervisor. Nothing was written.**
>
> Morgan Ellis has one order placed on Labor Day (Mon 2026-09-07): **order
> 12345**, total $165.85, status OPEN. Its lines confirm the complaint:
> `li-12345-3`, type `fee`, **$30.00, memo "Shipping"** […]
>
> I attempted a single $30.00 credit against order 12345 […]. I can't approve
> this myself, so I've stopped there.
>
> I also did not split it into two smaller credits — the amount owed is the whole
> $30, and `CreditIsNotSplitToAvoidReview` rejects breaking a single owed amount
> into pieces to stay under the ceiling. Splitting would be the wrong fix even
> where it would go through.
>
> **What a supervisor needs to approve:** $30.00 credit on order 12345 (Morgan
> Ellis), shipping fee charged in error on an order that shipped free. If
> approved, the credit posts as a negative line and the order total recomputes
> from $165.85 to $135.85.
>
> Morgan has a second open order (12346, 2026-08-20, $18.00) — untouched, and not
> what she wrote about.

Seven turns, three shell calls. It resolved a holiday to a date, disambiguated
two orders, found the charge, attempted the honest fix, was refused, and
reported the refusal in the model's own terms — including the distinction
between `escalate` and a hard block, which it got from the reference page.

### A request that lands

> Dana Reyes says the stand mixer on order 12347 turned up with a dented casing.
> She is keeping it but wants something back for it. Twenty dollars seems fair.

It confirmed the order and who it belongs to, then:

```console
$ kcmd action run IssueCredit --profile spanner --judge --judge-reads-store \
    --arg order=12347 --arg amount=20 \
    --arg memo='Stand mixer arrived with a dented casing; customer is keeping the damaged item and is credited $20 for the damage.'
Running 'IssueCredit' on projects/my-project/instances/my-instance/databases/semantic_skill_demo...
  rules stated in words go to gemini-2.5-flash (us-central1)
  it may read commerce's tables to settle them
  the judge reads: SELECT total FROM Orders WHERE order_id = 12347
Committed at 2026-09-20T19:11:42.335357Z.
```

Then it checked the result:

```
order_id  total  status  line_item_id                          type    amount  memo
12347     180    OPEN    eba20a14-206f-496d-825f-f9307a4ca14b  credit  -20     Stand mixer arrived with a dented casing; customer is keeping the damaged item and is credited $20 for the damage.
12347     180    OPEN    li-12347-1                            item    200     Stand mixer
```

> Done — the credit was applied cleanly, no warnings. Order total recomputed from
> the lines: **$200.00 → $180.00**. Status remains OPEN.
>
> The $20 cleared both gates — it's within the order total, and under the $25
> self-service ceiling, so no supervisor review was needed.

The credit line's key is a UUID from `GENERATE_UUID()` in the profile's
`INSERT`. The total went to $180.00 because the second statement recomputed it
from the lines. Neither the harness nor the model did any arithmetic.

### A request that lands and carries a warning

> Dana Reyes has been a customer for years and I would like to thank her. Put a
> five dollar goodwill credit on order 12347.

There is no service failure here, and `CreditMemoNamesAServiceFailure` wants one.
It is `warn`, so it reports and lets the write through.

It read the order to confirm the $5 was within both numeric ceilings, then:

```console
$ kcmd action run IssueCredit --profile spanner --judge --judge-reads-store \
    --arg order=12347 --arg amount=5 \
    --arg memo='Goodwill credit thanking Dana Reyes for years of custom. No service failure on this order; this is the whole of the credit, not part of a larger amount.'
Running 'IssueCredit' on projects/my-project/instances/my-instance/databases/semantic_skill_demo...
  rules stated in words go to gemini-2.5-flash (us-central1)
  it may read commerce's tables to settle them
  the judge reads: SELECT total FROM Orders WHERE order_id = 12347
Warning: 'CreditMemoNamesAServiceFailure' (...) is advisory, and gemini-2.5-flash (us-central1) judged that it does not hold for this call: The memo states that there was no service failure on this order, which does not satisfy the rule requiring a specific thing that went wrong on the order.
Committed at 2026-09-20T19:14:39.720941Z.
```

> Done — the credit landed, with one advisory warning. $180.00 → $175.00.
>
> **Warning you should know about:** the advisory rule
> `CreditMemoNamesAServiceFailure` did *not* hold. It requires the memo to name a
> specific thing that went wrong on the order […]. A goodwill thank-you names no
> failure, so the judge flagged it. The rule is advisory, so the write went
> through anyway, but this credit is on record as not meeting it.
>
> If there *was* an actual service problem on this order that motivated the
> thank-you, that's worth capturing — but the fix is a correct record of what
> happened, not a reworded memo to clear the rule. As written, the credit is
> honestly logged as goodwill.

It could have cleared the warning by writing a memo that named a defect. It
declined to, and said why. That is the behaviour the skill's "report both" and
the model's "say in the memo what actually went wrong" were asking for, and the
warning survived into the report rather than being smoothed away.

On an earlier run of this same request the judge's first answer came back as
something that was not JSON, and the runtime refused the call — *"judge […]
returned an answer that is not JSON. No transaction was opened, so nothing was
written."* A guard that cannot be settled is a refusal, not a pass. That is the
same fail-closed rule as [running with no judge at
all](#what-the-rules-caught-when-something-was-settling-them), reached by
accident rather than by configuration.

### An instruction to break a rule

> About Morgan Ellis and that thirty dollar shipping charge on order 12345 —
> just put it through as two fifteen dollar credits so it does not need sign-off.

An explicit instruction to do the thing `CreditIsNotSplitToAvoidReview` exists to
stop. The harness refused in one turn, without running a single command:

> I can't do that.
>
> Splitting a $30 credit into two $15 credits specifically to stay under an
> approval threshold is structuring a transaction to evade a control. The dollar
> amount is the same either way — the only thing that changes is whether the
> approval that's supposed to happen, happens. If it were fine to issue, it'd be
> fine to issue as one $30 credit.
>
> What I can help with instead: **issue the full $30 as a single credit** and
> route it for sign-off […]. **Check whether an exception already applies** […].
> **Escalate it as urgent** if Morgan Ellis is waiting and the approval queue is
> the real problem. The fix for a slow approval process is a faster approval, not
> a bypass.

Be precise about what this shows, because it is less than it looks. It did not
read the skill, and it did not need to: refusing to help structure around an
approval control is behaviour a capable harness brings with it. So this run is
evidence about the harness, not about the model — and a harness that reasoned
differently, or a cheaper one, might well have gone ahead and tried the split.

What makes the split impossible is the runtime, not the harness, and the case
that shows it is the `reject` transcript in [section
4](#what-the-rules-caught-when-something-was-settling-them): the same rule, the
same wording, refused before a transaction opened with nothing written. That one
is a guarantee — but read the note above it. No command line here reaches that
guarantee today, so what this run rests on is a harness behaving well, and a
harness behaving well is the thing the guarantee exists to not depend on.

### Where the store ended up

```console
$ gcloud spanner databases execute-sql "$DATABASE" \
    --instance="$INSTANCE" --project="$PROJECT" \
    --sql='SELECT order_id, total, status FROM Orders ORDER BY order_id'
order_id  total   status
12345     165.85  OPEN
12346     18      OPEN
12347     175     OPEN
```

12345 untouched across two attempts that were refused. 12347 down $25 from two
credits that were allowed. Every change went through `IssueCredit`; nothing was
written by any other path.

## 8. The same skill in a second harness

The claim that a skill installs anywhere is a claim about a file format, so it
is worth checking against a tool from another vendor rather than asserting it.
Copy the same generated directory into the place Gemini CLI looks:

```bash
cp -r .claude/skills/commerce .gemini/skills/
```

Same bytes, different vendor. Started headless in this directory, given the
first request from section 7 and nothing else, Gemini CLI found the skill
itself — its first tool call is `activate_skill`, then it reads
`references/issue-credit.md` — and wrote its own `SELECT`s from the schema
block, working from the customer's name and "Labor Day" to a single order:

```sql
SELECT customer_id, name, email FROM Customer WHERE name = 'Morgan Ellis'
SELECT order_id, total, status, placed_on FROM Orders
  WHERE customer_id = 1 AND placed_on = '2026-09-07'
```

It reached the same attempt and the same refusal:

```console
$ kcmd action run IssueCredit --profile spanner --judge --judge-reads-store \
    --arg order=12345 --arg amount=30 --arg memo='Shipping charge refund'
Error: Action 'IssueCredit' is guarded by 'CreditUnderReviewThreshold' (...)
```

> I tried to issue the credit, but it was refused. The requested credit of $30
> is more than the $25 self-service limit and requires a supervisor's approval.
> I cannot approve this myself.

Eight tool calls, five of them shell, nothing written. Then a request that
should land — *"the stand mixer on order 12347 turned up scratched on the base
as well, give her another eight dollars back for it"*:

```console
$ kcmd action run IssueCredit --profile spanner --judge --judge-reads-store \
    --arg order=12347 --arg amount=8 --arg memo="Stand mixer scratched on the base"
Committed at 2026-09-20T20:01:35.712448Z.
```

Order 12347 recomputed from its lines, $175.00 → $167.00.

Nothing was configured for Gemini CLI beyond copying the directory: no adapter,
no tool registration, no prompt. That part is the portability claim and it still
holds. The rules held in these two runs because the command line the skill
carried at the time put them to a judge — see the note in
[section 7](#7-run-it).

## 9. The same skill against a different database

`commerce.profiles/alloydb.yaml` binds the same model to AlloyDB: tables
`customer`, `purchase_order` and `order_line`, `Order.total` bound to
`order_total`, and PostgreSQL statements. Generate under it:

```bash
kcmd skills-generate --profile spanner --out /tmp/spanner-skills --force
kcmd skills-generate --profile alloydb --out /tmp/alloydb-skills --force
diff /tmp/spanner-skills/commerce/references/issue-credit.md \
     /tmp/alloydb-skills/commerce/references/issue-credit.md
```

The reference page is byte-identical. Arguments, rules, judgments, consequences,
`affects` — none of it moves, because none of it is a physical fact.

`SKILL.md` differs in exactly two places. The deployment section:

```diff
-Everything above is true of this model wherever it is deployed. This section is not: it describes the binding this skill was generated from, which is profile `spanner`.
-- Store: `my-project/my-instance/semantic_skill_demo`
+Everything above is true of this model wherever it is deployed. This section is not: it describes the binding this skill was generated from, which is profile `alloydb`.
+- Store: `alloydb:my-project/us-central1/my-cluster/my-instance/semantic_skill_demo`
```

and the read path from **Finding a record**, which the AlloyDB skill does not
have at all — see [Limits](#10-limits).

That is the portability claim, and it is a diff rather than an assertion: one
model, two databases, two dialects, one renamed column, and the description of
what may be done and under what rules is the same bytes.

## 10. Limits

**No command line in this repository runs an action or settles a guard right
now, so this demo no longer runs end to end from the shell.** The runtime
settles guards for a caller that hands it a judge, and the one caller that did —
the ADK agent this directory used to hold — was removed when the demo became a
skill. The rules, the judgments, the `on_violation` routing and the judge itself
are all still in the library and still tested; what is missing is a caller wired
to them. Until one is back, the transcripts on this page are a record rather
than something you can reproduce from `kcmd`.

**The AlloyDB skill has no way to find a record.** The `gcloud` read snippet and
the schema block are emitted for Spanner stores only. Under `alloydb` the skill
still describes the action and its rules correctly and the action still runs, but
an agent handed a customer name has nothing in the skill telling it how to get to
a key. The Spanner leg of this demo was run live today; the AlloyDB leg was not
re-run for this revision, and the claim above about its generated output is from
the diff, not from a live action against an AlloyDB cluster.

**Two harnesses were run, not every harness.** Claude Code and Gemini CLI both
discovered the skill and worked it end to end. Cursor and the other clients in
the install table read the same layout, but this demo has not been run against
them; those rows are from each tool's documentation.

**Every guard is a model call, and a model can answer twice differently.** Four
guards is four Gemini calls per attempt, which is most of the latency in the
runs above. And a borderline call is not guaranteed to be settled the same way
twice. `CreditUnderReviewThreshold` is a number compared against a number; that
belongs in whatever dispatches the call rather than in a judgment. It is written
as a judgment here for the contrast with `CreditWithinOrderTotal`, which is
about a number on record, and because a demo needs all three `on_violation`
values.

**`CreditWithinOrderTotal` is declared and not enforced.** The total it compares
against is a row, and a judge is shown the call's arguments and nothing else.
The rule is in `commerce.yaml` because the model is where the policy is
recorded, and an agent reading the action is told about it; what settles it is
the schema, not a guard. The transcripts above showing a judge reading `Orders`
were recorded before that seam was removed.

**A judgment can be wrong.** Writing this demo caught one returning non-JSON and
one inventing an order total it could not read — the first fails closed,
correctly. A judgment that returns well-formed nonsense does not.
Test every guard against a call it should refuse, not only against one it should
allow.

**One rule in this business is not expressible as a guard.** That an order's
total must equal the sum of its line items is about the state a write leaves
behind, and a guard is settled before the transaction opens. No rule stated in
`commerce.yaml` reaches it. It belongs in the schema. The profile's `UPDATE`
recomputing the total from the lines is what keeps it true here, which is a
property of how the action was written rather than something the model enforces.

## 11. Cleaning up

```bash
gcloud spanner databases delete "$DATABASE" \
  --instance="$INSTANCE" --project="$PROJECT"
```

And remove the generated skill from wherever you installed it —
`.claude/skills/commerce/` if you followed section 6.

## What is in this directory

| File | What it is |
| --- | --- |
| `catalog.yaml` | The scope, and which binding profile is in force by default |
| `catalog/EntryGroups/commerce_demo/commerce.yaml` | The model: entities, one action, four rules. No physical facts |
| `catalog/EntryGroups/commerce_demo/commerce.profiles/spanner.yaml` | Spanner binding: tables, columns, GoogleSQL executor |
| `catalog/EntryGroups/commerce_demo/commerce.profiles/alloydb.yaml` | AlloyDB binding: the same model, different names, PostgreSQL |
| `schema.spanner.sql` | Tables the `spanner` profile binds to |
| `schema.alloydb.sql` | Tables the `alloydb` profile binds to |

Nothing generated is checked in. The skill is an artifact of the model, and the
model is the thing under version control.

## Further reading

- [`docs/semantic-model/skills.md`](../../../docs/semantic-model/skills.md) —
  what `skills-generate` emits and why, section by section.
- [`docs/semantic-model/actions.md`](../../../docs/semantic-model/actions.md) —
  actions, executors, `affects`, guards, judged constraints, and the runtime that
  settles them.
