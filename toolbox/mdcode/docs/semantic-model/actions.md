# Modeling write operations

Your semantic model defines what your data means, and its metrics define what
you can read from it. An **action** is the write-side counterpart. It is a named
operation that changes state, declared over the same concepts as the rest of
your model.

When you declare an action, you name the operation, type its inputs against your
ontology, and say which concepts the call changes. We keep the physical
execution — how the write actually happens — in a separate field called the
**executor**: an MCP tool, a REST endpoint, a gRPC method, or DML. That is the
one physical part of an action, so it can reach the action from a binding
profile instead of from your model.

Publishing an action puts the operation in the same place as the data it acts
on. An agent that discovers your model then discovers what it can change there,
rather than only what it can ask.

You write an action across two files. Your model names the operation and its
parameters; a binding profile names the tables, the columns, and the executor.
kcmd combines them into a bound model, and that bound model is what reaches your
store and what an agent is handed as tools.

```mermaid
graph LR
    M["the model<br>concepts, actions, constraints"]
    P["a binding profile<br>tables, columns, executor, target"]
    RT(["one model, bound<br>ready to run"])
    ST["the store<br>where a write lands"]
    AG["what an agent is handed<br>write tools, lookup tools, instruction"]

    M --> RT
    P --> RT
    RT --> ST
    RT --> AG
```

*Figure 1: your model and a binding profile combine into one bound model, which
both reaches your store and supplies the tools an agent is handed.*

## When to use an action

Declare an action when a write against this data already exists somewhere — a
service call, an endpoint, some DML. Once you declare it, anything that reads
your model knows the operation exists, what it takes, and where it lives. Until
then, that write is visible only to whoever wrote the service around it.

An action does not answer a question about your data. Use a
[metric](README.md#1-author-the-logical-model) for that.

## 1. Declare the action

Start here. The name and the parameters that you write in this step are the
contract every later step builds on, and they live in your model and nowhere
else.

Actions sit at model level, beside your metrics. Each one carries a name, its
parameters, and an executor. Treat the executor as a default, because it is the
one part a binding profile can replace:

```yaml
version: "0.2.0.dev0/google"    # `actions` is a kcmd extension key
semantic_model:
  - name: payments
    entities:
      - name: Account
        description: A customer's money at this bank.
        primary_key: [accountId]
        source: my-project.bank.account
        fields:
          - { name: accountId,      datatype: Integer, expression: account_id }
          - { name: name,           datatype: String,  expression: name }
          - { name: balance,        datatype: Float,   expression: balance }
          - { name: minimumBalance, datatype: Float,   expression: minimum_balance }
          - { name: status,         datatype: String,  expression: status, description: "open, frozen or closed." }
      - name: Transfer
        description: One movement of money between two accounts.
        primary_key: [transferId]
        source: my-project.bank.transfer
        fields:
          - { name: transferId, datatype: Integer, expression: transfer_id }
          - { name: amount,     datatype: Float,   expression: amount }
          - { name: debitedId,  datatype: Integer, expression: debited_account_id }
    relationships:
      - name: TransferDebits
        from: Transfer
        to: Account
        from_columns: [debitedId]
        to_columns: [accountId]
    actions:
      - name: TransferFunds
        description: Move money from one account to another.
        executor:                             # one kind only: mcp / rest / grpc / sql
          mcp:
            server: //agentregistry.googleapis.com/projects/acme-ops/locations/us-central1/mcpServers/payments
            tool: transfer_funds
        parameters:
          - { name: source, type: Account }   # an entity: an object reference
          - { name: target, type: Account }
          - { name: amount, type: Float }     # a scalar: an ordinary value
        ai_context:
          instructions: >-
            Resolve both accounts before calling. Name the account the money
            leaves as `source`.
    ai_context:                             # model level: true of every caller
      instructions: >-
        Never move money between two accounts held by the same customer
        without saying so in your answer.
```

You author the rest of the model — the deployment target, the entity bindings,
the relationships — as you would for any model. See
[Deploying a semantic model](README.md).

The executor tells a consumer where the operation lives. Choose one of these
four kinds, and give any one executor no more than a single kind:

1. **`mcp`** — `{server, tool}`. A tool that you have already registered in
   Agent Registry, named by the server's resource name and the tool's name
   within it.
2. **`rest`** — `{endpoint, method}`. An HTTP endpoint and the verb to call it
   with.
3. **`grpc`** — `{service, method}`. A service and the method on it.
4. **`sql`** — `{statements}`. The write itself, carried in your model rather
   than named as a pointer to whoever performs it. See [writing the statements
   in the model](#writing-the-statements-in-the-model).

We carry both `description` and `ai_context.instructions` through to the
catalog. Write those instructions for the agent that will call the action, as
above.

### The executor is a binding

Everything else your action declares is logical — what it takes, what gates it,
what it changes. The executor is not. It says *how* the change is carried out,
and that depends on your store. When the rows sit in a relational database, the
write is DML. When they sit elsewhere, the write is a call to whoever owns them.
Even two relational stores differ, each with its own table names and dialect.

So we treat the executor as a physical binding, like an entity's `source`, and a
[binding profile](profiles.md) can supply or replace it:

```yaml
# commerce.profiles/operational.yaml — this store owns the rows, so it writes them
semantic_model:
  - name: payments
    actions:
      - name: TransferFunds
        executor:
          sql:
            statements:
              - UPDATE account SET balance = balance - @amount WHERE account_id = @source
              - UPDATE account SET balance = balance + @amount WHERE account_id = @target
```

If your profile says nothing about an action, that action keeps your model's
executor. The `mcp` executor in the model above is therefore the default for
every store, and this profile overrides it for the one store that performs the
write as DML. Write `executor: null` in a profile to withdraw it, which gives
you a read-only binding that performs no writes.

The four kinds differ in whether they belong in your model. An `mcp`, `rest`, or
`grpc` executor names an operation in another system, and that name usually does
not change with the store, so put it in the model, as above. A `sql` executor is
the write itself, written in one database's own table and column names, so put
it in that database's profile unless your model will only ever have one store.

Sometimes nobody has wired the write up yet, or another team owns it and you
need your model only to record that it exists. Leave the executor out of both
files for that case. Your action is then **declared but not performable**: it
still states what it does, what gates it, and what it changes, which is the
whole of what a reader needs. A catalog-only push — `--no-profile`, or a model
with no deployment target — publishes it like any other action, and `kcmd
profiles` lists it under `cannot run:` for each binding that supplies no
executor for it.

A push that also deploys a graph behaves the way it already does for your
metrics: the catalog entries reflect the binding you pushed, pruned to what that
binding can do. If a binding cannot perform an action, those entries omit it.
Your model owns its action entries for delete reconciliation, so pushing that
binding removes an entry an earlier push published. The catalog holds one
binding's view of your model, so name that binding as `default_profile` in
`catalog.yaml`, choosing it as you would for a metric that a single store can
answer.

### What an entity-typed parameter adds

A hand-written tool schema can tell a caller that an input is an integer or a
string. A parameter typed against your model says what the input *denotes*:

> **A parameter typed by an entity is an object reference.**

Writing `{name: source, type: Account}` says the argument names an account. A
consumer generating a tool schema then knows to accept an identifier and resolve
it against `Account`'s key rather than pass a number through. A parameter typed
by a scalar datatype, such as `amount` above, is an ordinary value.

### Writing the statements in the model

The three kinds above name a system that performs the write, which leaves the
write opaque to your model: it states an `affects` list, and nothing can check
that list against reality. The fourth kind, `sql`, carries the write itself, so
what your action does becomes readable — and checkable — from the model.

```yaml
      - name: TransferFunds
        executor:
          sql:
            statements:
              - UPDATE account SET balance = balance - @amount WHERE account_id = @source
              - UPDATE account SET balance = balance + @amount WHERE account_id = @target
        parameters:
          - { name: source, type: Account }
          - { name: target, type: Account }
          - { name: amount, type: Float }
        affects:
          - { concept: Account, operation: modify, fields: [balance] }
```

### Statements use your database names

Look closely at what those statements say. The entity is `Account` and its field
is `accountId`, but the statement writes `account` and `account_id`. Those are
the table and the column that `source` and `expression` bind the entity to.

Every entity and field therefore carries two names, one in your model and one in
your database. You write a metric in the model's names, and kcmd translates
`Account.balance` into `account.balance` before any SQL reaches your store. **We
do not translate an action's statements.** We hand them to your store as
written, so every table and column in one has to be the database's own name. The
only model names in a statement are the `@parameter` references, which name the
parameters your action declares.

That is the price of carrying the write verbatim. A rewrite step could make the
statement that runs differ from the statement you reviewed.

Nothing catches a model name before the call. Validation checks that each
statement is one DML verb, contains no `;`, and binds only declared parameters —
it never asks your store whether a table exists. A model name therefore fails at
run time, from the store, and the message can be hard to read: an entity named
`Order` bound to a table named `Orders` produces

```
Syntax error: Unexpected keyword ORDER [at 1:8]
```

rather than "no such table", because `ORDER` is a reserved word.

Carrying the write, rather than pointing at it, buys you three things:

- **Your blast radius is checkable.** A reader can compare `affects` against the
  statements instead of taking it on trust.
- **A guard becomes a real gate.** An MCP, REST or gRPC call commits inside a
  system kcmd does not control, so a check wrapped around it is advisory. A
  statement runs in the caller's own transaction and can be rolled back.
- **The gate sees the write.** The statements run where the constraints are
  probed, so a check observes the uncommitted result of the write it is gating.

Narrowness is what makes that safe, and push holds you to it:

- Write each statement as a **single `INSERT`, `UPDATE` or `DELETE`**. A
  statement that reads is a query and belongs in a metric; one that reshapes the
  schema is not an action. We reject a `;` inside a statement, because each list
  entry runs on its own and anything after the separator would silently not run.
- Pass every value as a **bound `@parameter`** naming a parameter your action
  declares. We interpolate nothing into the statement text, so an argument
  cannot become SQL.
- Expect no control flow, and no statement composed at call time. An action
  whose body arrives with the call declares nothing, and a gate cannot check
  what was never declared.

An action that **creates** a row needs a key for it, and that key cannot come
from the caller: an agent that picks its own primary keys can overwrite an
existing row by choosing one already taken. Declare the creation in `affects`
and refer to the generated key as `@new<Concept>Key`:

```yaml
        executor:
          sql:
            statements:
              - >-
                INSERT INTO transfer (transfer_id, amount, debited_account_id)
                VALUES (@newTransferKey, @amount, @source)
        affects:
          - { concept: Transfer, operation: create }
```

kcmd runs a `sql` executor and no other kind — see [run it](#7-run-it). We
publish the other three for whoever reads your model to dispatch.

## 2. Gate it with a constraint

Section 1 gave you an action that runs. This step is how you stop it running
when it should not. A **constraint** is a named rule your model states over its
ontology. Declaring one adds it to the catalog and changes nothing by itself. A
constraint takes effect where something references it and nowhere else, so
publishing a rule cannot quietly start refusing calls that succeeded yesterday.

A rule passes through four stages, and one that stops at the first does
nothing:

```
  declared                referenced             checked            a breach
  ─────────────────       ─────────────────      ──────────────     ───────────
  constraints:            actions:               before the call,   reject
    - name: X       ──▶     - name: Y      ──▶   with the      ──▶  escalate
      expression: …           guards: [X]        arguments bound    warn
      or judgment: …

  a rule in the           the only thing that    a query settles    on_violation
  catalog, inert          gives it effect        an expression;     names one of
                                                 a language model   the three
                                                 a judgment
```

*Figure 2: a constraint moves from declared, to referenced by an action, to
checked before a call, to a breach routed by `on_violation`.*

Write an expression over stored data to state a condition your data must
satisfy:

```yaml
    constraints:
      - name: BalanceStaysPositive
        expression: Account.balance >= Account.minimumBalance
        description: >-
          An account cannot be taken below its minimum balance.
```

On its own that is a catalogued rule and no more. Nothing consults it, and no
write is refused for breaking it. It acquires effect when an action names it.

An expression that reads an action's **parameters** describes one call rather
than the stored data, so the only moment you can check it is before that call
runs:

```yaml
    constraints:
      - name: AmountIsPositive
        expression: amount > 0
        description: >-
          A transfer must move at least one unit. Ask the caller for the
          amount again before retrying.
    actions:
      - name: TransferFunds
        executor:
          mcp:
            server: //agentregistry.googleapis.com/projects/acme-ops/locations/us-central1/mcpServers/payments
            tool: transfer_funds
        parameters:
          - { name: source, type: Account }
          - { name: target, type: Account }
          - { name: amount, type: Float }
        guards: [AmountIsPositive]
```

`guards` holds the names of constraints your model declares, and it is how a
constraint acquires effect over an action. Put both kinds of rule there. A rule
that reads the action's parameters has no other moment to run. A rule over
stored data, named as a guard, says the call must not proceed on data that is
already broken.

We check every guard before the call, with the arguments bound. What each rule
reads decides how much that moment can tell you. A rule over the parameters is
settled completely there, since the arguments are the whole of what it reads. A
rule over stored data is a condition on the state that a write produces, so
checking it before the call reports only that the call is not starting from a
broken state. It does not report that the call leaves a sound one. Nothing in
your model binds a rule to the result of a write, and that is the gap between
what a data rule says and what a guard can enforce.

Whatever dispatches the call is what checks its guards. Handing a rule to your
store instead works for some rules and not others. A condition on a single row
lowers to a store-level `CHECK`. One that aggregates across a child table, such
as an order total matching the sum of its line items, lowers to neither Spanner
nor BigQuery.

Put the reference on the action rather than on the constraint, because the same
rule may gate `TransferFunds` and leave `CloseAccount` alone.

`guards` and `on_violation` are independent, as the two right-hand columns of
figure 2 are: one says when we check the constraint, the other says what a
breach does. So guarding a constraint that declares `warn` is a real shape. Your
organization may not be ready to block on a rule; guarding it anyway still gets
the rule checked at the moment of the call and reported back.

### When no expression decides it

Your business enforces some rules that cannot be written as a boolean. A credit
memo may or may not explain the failure it claims to refund. A discount may or
may not be justified by the reason given. In both cases a query can read the
text and cannot settle the question. Write such a rule in `judgment` instead of
`expression`:

```yaml
    constraints:
      - name: CreditMemoNamesAServiceFailure
        judgment: >-
          LineItem.memo must name a specific, verifiable service failure on the
          order: a late delivery, a damaged item, a shipping charge applied in
          error. A memo that states only that the customer requested a credit
          does not satisfy this rule.
        description: >-
          Say what went wrong with the order in the credit memo.
        on_violation: warn
        severity: low
```

A constraint declares one body or the other, never both and never neither. A
judgment has to state `on_violation`, and it may state any of the three words.
Leaving the key out is the one thing it may not do: an unmarked constraint
rejects, and that is too strong a consequence to inherit by silence.

### Writing a judgment

A language model reads your sentence at review time with the proposed write in
front of it. Five habits make that reading consistent.

**State what must be true of the data.** Write the condition — *the memo must
name a specific service failure* — rather than the procedure — *check whether
the memo is specific*. Your sentence describes a clean write, and everything
about handling a breach lives elsewhere.

**Name fields model-qualified.** Write `LineItem.memo` rather than "the memo".
kcmd resolves every `Entity.field` token in the text against your model and
fails the push when the entity declares no such field, so a rename cannot leave
your sentence pointing at nothing. The qualified name also tells the judge which
value to read.

**Say what does not count.** A rule with no negative example is graded against
whatever the model guesses you had in mind. The sentence "A memo that states
only that the customer requested a credit does not satisfy this rule" buys you
more consistency than any further description of what a good memo is.

**Leave the consequence out of the prose.** What happens on a breach is
`on_violation`. A judgment ending "…otherwise escalate to a supervisor" states a
routing nothing reads, and the engine routes by the field regardless.

**Keep it to one condition.** When your sentence needs "and also", the second
half is a second constraint. One `on_violation` cannot carry two consequences,
so two conditions that end differently cannot share a constraint.

Those five are about wording. Claim no more in the wording than a judge can
settle.

A judge settles a guard from the call's arguments and whatever it could read, so
a sentence about stored data can turn out to be a rule it has no evidence for.
We instruct it to refuse in that case and say what is missing, but that
instruction binds a model rather than the runtime, so the rule can come back
held instead — a guard that never fires and never says why. Phrase the condition
around the arguments the call carries, and try every judged guard against a case
it ought to refuse.

A rule that does need a stored row — comparing a credit against the order total,
say — is settled when you run with `--judge-reads-store`. Word it to say the
value is on record and has to be read, because the judge decides for itself
whether to look. The same rule refuses every call when it goes to a judge that
cannot read. See [a guard that reads a row](#a-guard-that-reads-a-row).

No judge settles a rule about the state a write *leaves behind*, however much it
can read. Guards run before the transaction opens, so "an order's total equals
the sum of its lines" has nothing to look at yet. Put that rule inside the
transaction or in your schema.

### A policy whose rules end differently

Real policies have several rules, and the rules rarely end the same way. Take
the policy governing a customer-service credit, stated the way a business states
it. The listing below puts the two things your model has to settle beside each
rule:

```
  the business rule                        written as   a breach
  ──────────────────────────────────────   ──────────   ────────
  1  no credit above the order's total     expression   escalate
  2  over 25 dollars needs a supervisor    expression   escalate
  3  the total equals the line items       expression   reject
  4  the memo names a service failure      judgment     warn
  5  not one credit split to evade review  judgment     reject
```

*Table 1: the five rules of the credit policy, how each one is written, and what
a breach of it does.*

Those five rules produce three different outcomes, and no query can settle two
of the five. The model has an `Order` with a `total`, a `LineItem` with an
`amount` and a `memo`, and an `IssueCredit` action taking the order, the amount
and the memo. Each rule becomes one constraint, carrying its own outcome in its
own `on_violation`:

```yaml
    constraints:
      # Rules a query can compute.
      - name: CreditWithinOrderTotal              # rule 1
        expression: amount <= Order.total
        description: >-
          A credit cannot exceed the total of the order it credits. Lower the
          amount, or split it across the orders it actually covers.
        on_violation: escalate
        severity: high

      - name: CreditUnderSelfServiceLimit         # rule 2
        expression: amount <= 25
        description: >-
          A credit over 25 dollars is above the self-service limit. A
          supervisor decides it.
        on_violation: escalate
        severity: medium

      - name: OrderTotalMatchesLineItems          # rule 3
        expression: Order.total == SUM(LineItem.amount)
        description: >-
          An order's total must equal the sum of its line items, with credits
          subtracted.
        on_violation: reject
        severity: critical

      # Rules no query can compute.
      - name: CreditMemoNamesAServiceFailure      # rule 4
        judgment: >-
          LineItem.memo must name a specific, verifiable service failure on the
          order: a late delivery, a damaged item, a shipping charge applied in
          error. A memo that states only that the customer requested a credit
          does not satisfy this rule.
        description: >-
          Say what went wrong with the order in the credit memo.
        on_violation: warn
        severity: low

      - name: CreditIsNotSplitToAvoidReview       # rule 5
        judgment: >-
          A credit must not appear to be one larger credit divided into parts
          that each stay under the 25-dollar self-service limit. Read the
          proposed amount together with the other credits already on the same
          Order: several near-limit credits raised close together for related
          reasons are one credit, whatever each memo says on its own.
        description: >-
          Raise this as a single credit for the full amount and send it for
          supervisor review.
        on_violation: reject
        severity: critical

    actions:
      - name: IssueCredit
        executor:
          mcp:
            server: //agentregistry.googleapis.com/projects/acme-ops/locations/us-central1/mcpServers/commerce
            tool: issue_credit
        parameters:
          - { name: order,  type: Order }
          - { name: amount, type: Decimal }
          - { name: memo,   type: String }
        guards:
          - CreditWithinOrderTotal
          - CreditUnderSelfServiceLimit
          - OrderTotalMatchesLineItems
          - CreditMemoNamesAServiceFailure
          - CreditIsNotSplitToAvoidReview
```

Read down the `on_violation` column and you get the branching your policy
describes in prose, in a column a search can read.

**Rule 3 is named like the rest, because an unnamed rule does nothing.** It is
the one rule here that nobody in the business may approve: an order whose total
disagrees with its line items is broken rather than unusual, which is why it
says `reject`. That word buys you nothing until an action names the rule. Left
out of every `guards` list it would be a rule the catalog records and no call
consults, and the strongest word in your policy would be the one with the least
effect.

Naming it makes `IssueCredit` refuse to run against an order whose books already
disagree. Catching the credit that *breaks* the agreement is a different check,
against the state the write produces, and your model cannot bind one yet. Rule 3
is the rule in this policy whose enforcement sits furthest from what it says.

**Rules 4 and 5 are why the second body exists.** Neither reduces to arithmetic
over `Order` and `LineItem`, and before `judgment` they had nowhere to go but a
policy document nothing links to. Note what stays computable alongside them: the
threshold in rule 2 is arithmetic, so it remains an expression a query settles
and no model call is spent on. Folding rules 2, 4 and 5 into one paragraph of
prose, on the grounds that a model could read all three, would throw that away.

**Rule 5 is a judgment that declares `reject`.** Splitting a credit to evade
review is a rule the business means as unappealable, and no expression detects
it, so the alternative to writing it this way is leaving it out of your model.
The pairing carries a real cost, because a language model can decide two
identical credits differently and `reject` leaves nobody to appeal to. We
publish it rather than forbid it, and we make it findable: every constraint
carries a derived `evaluation` field, which reads `judged` here, so an auditor
asking which unappealable rules your model settles gets an answer from one
query.

### Two calls through that policy

Here are two calls against order 12345, which totals 142 dollars. One is a
30-dollar credit for a shipping charge billed in error. The other is three
9-dollar credits raised within the hour, each memo reading some version of
"customer asked":

```
                                  amount=30.00,          amount=9.00 x3,
                                  "shipping charge       "customer asked"
                                   applied in error"
  ──────────────────────────────  ─────────────────────  ─────────────────────
  1  within the order's total     holds                  holds
  2  under the 25-dollar limit    violated ─▶ escalate   holds
  3  total matches line items     holds                  holds
  4  memo names a failure         holds                  violated ─▶ warn
  5  not split to evade review    holds                  violated ─▶ reject
  ──────────────────────────────  ─────────────────────  ─────────────────────
  strictest outcome wins          held for a supervisor  refused, with the
                                                         memo warning reported
```

*Table 2: how each of the two calls fares against the five rules, and the
outcome that wins.*

The supervisor who gets the first call reviews a credit against an order rather
than a SQL diff. The second call is the case the judged rules were added for:
every gate a query can compute lets it through, because the policy is evaded by
staying inside the arithmetic.

When one call violates several guards, the strictest outcome applies. Any
`reject` refuses the call; failing that, any `escalate` holds it; failing that,
any `warn` lets it through with the violations reported.

That combination is fixed, and no part of your model states it. It is why your
action can name any number of guards without you writing down how to combine
them. It is also how `forbid` overrides `permit` in Cedar and how a deny wins in
Open Policy Agent, so a policy written this way lowers into either.

An action whose guards are *all* judged loads with a warning. Every gate then
costs a model call, none can lower to a store-level check, and each may decide
two identical calls differently. `IssueCredit` stays clear of that: three of its
five guards are expressions.

**Status: we settle a judgment, and we do not settle an expression.** kcmd
parses both bodies, validates them, publishes them with the `guards` that name
them, and reads them all back, along with a derived `evaluation` field reading
`deterministic` or `judged` so a consumer can select on it. At run time,
[`kcmd action run --judge`](#a-guard-settled-in-words) puts each judged guard to
a language model and routes the verdict by `on_violation`. No component here
evaluates an expression against live data, so
[`kcmd action run`](#7-run-it) refuses an action whose `guards` name one rather
than apply a write your model says must be checked first — and `IssueCredit`
names three. The two calls above are therefore what the published policy says
should happen, rather than what kcmd does with this action today.

kcmd reports a mismatch from either side. A guard that names no constraint fails
the push. A constraint over parameters that no action names loads with a
warning, because nothing will ever evaluate it. That scan reads expressions
only: a judgment is prose, in which a word matching a parameter name is not a
read of that parameter.

## 3. Say what it changes

An executor is opaque. Writing `mcp: {server, tool}` says where the operation
lives and nothing more, so no reader of your model can see what that tool
writes. Declare the blast radius of a call or it stays unknown, and `affects` is
where you declare it:

```yaml
        affects: [Account, Transfer]
```

That is the coarse form: these concepts are touched, in a way your model does
not spell out. It is enough to answer *which actions can change an account at
all*, which is already more than an executor name answers.

A record says more — which operation, and which fields the call writes:

```yaml
        affects:
          - concept: Account
            operation: modify
            fields: [balance]
          - concept: Transfer
            operation: create
          - concept: TransferDebits
            operation: create
```

Be precise about the concepts you have worked out and coarse about the rest. The
two shapes sit in one list together, so a vague entry costs you nothing on the
ones you know. Every `concept` — bare, or named under the key — has to be
something the same model declares.

### One key for both kinds

`concept` names an entity or a relationship, and your model already knows which.
Asking you to repeat it would add a second place to get the answer wrong, and it
would change nothing about what the action affects. `TransferDebits` above is
the edge from the example model, and you write it the same way as the two
entities beside it.

### The operations

Use `create`, `modify` or `delete` — the same three whatever the concept is.

An edge is not only attached and detached. A junction table backs a many-to-many
relationship, and that table has fields of its own. *Modify the grade on an
Enrollment* is therefore as ordinary a change as *modify an order's total*. A
vocabulary that gave edges only `add` and `remove` could not express that
change.

Add `fields` to narrow a `create` or a `modify` to the fields the call writes,
which is what makes *which actions can change `Account.balance`* answerable. A
`delete` takes the whole instance, so we reject a field named beside one rather
than ignore it.

Name the concept now and refine it later. Writing `- concept: Account` on its
own says the same thing the bare `Account` does, and we write it back as the
bare form.

**Status: nothing consumes `affects` yet.** kcmd parses it, checks every concept
against your model, publishes it and reads it back. No component computes an
impact from it, routes on it, or checks it against what your executor does.

## 4. Check it before pushing

Run this before you push, so a typo costs you a second rather than a round
trip:

```bash
kcmd push --validate-only
```

Four things about an action can be statically wrong once your document parses,
and we treat each one as a hard error:

```
action 'TransferFunds' in model 'payments' (payments.yaml) has parameter
'target' whose type 'BankAccount' is neither a known entity nor a scalar
datatype.

action 'TransferFunds' in model 'payments' (payments.yaml) has an mcp executor
whose 'tool' is missing or blank.

action 'TransferFunds' in model 'payments' (payments.yaml) is guarded by
'AmountIsPostive', but model 'payments' declares no constraint of that name.

action 'TransferFunds' in model 'payments' (payments.yaml) affects 'Acount',
which is neither an entity nor a relationship this model declares.
```

A parameter type that resolves to neither an entity nor a scalar means your
model cannot say what that argument denotes, which is the whole contribution an
action makes. An executor missing a coordinate cannot be dispatched by whatever
picks the action up. A guard can name a constraint your model never declares;
`AmountIsPostive` here misspells the `AmountIsPositive` declared above, which
leaves you believing the write is checked when nothing checks it. An `affects`
entry naming `Acount` describes a blast radius over a concept that does not
exist, so anything reading it reads about nothing.

kcmd checks the rest of an entry the same way and for the same reason. Fields
beside a `delete` are a hard error, and so is a field the concept does not
declare. An operation outside `create` / `modify` / `delete` never gets this far
— the vocabulary is closed, so your document does not parse at all. All of these
checks are static, so they run on every push whatever the destination.

## 5. Push it

```bash
kcmd push
```

Knowledge Catalog is the one system your action reaches. Every other push target
deploys nothing for it and warns once:

```
Warning: [payments] 1 action(s) reach Knowledge Catalog only; the BigQuery
push deploys none of them.
```

A graph-only `kcmd push --no-kc` therefore validates your actions and then warns
that it will not deploy them.

In Knowledge Catalog, each action becomes its own entry, parented to the model
entry, the same way a metric does. The entry carries one aspect holding the
executor and the typed parameters:

```yaml
# .../entryGroups/<group>/entries/payments.actions.TransferFunds
entryType: projects/<project>/locations/global/entryTypes/semantic-action
parentEntry: .../entryGroups/<group>/entries/payments
entrySource:
  displayName: TransferFunds
  description: Move money from one account to another.
aspects:
  <project>.global.semantic-action:
    executorKind: mcp
    mcpServer: //agentregistry.googleapis.com/projects/acme-ops/locations/us-central1/mcpServers/payments
    mcpTool: transfer_funds
    parameters:
      - {name: source, type: Account, isEntityRef: true}
      - {name: target, type: Account, isEntityRef: true}
      - {name: amount, type: Float, isEntityRef: false}
    affects:
      - {concept: Account, operation: modify, fields: [balance]}
      - {concept: Transfer, operation: create}
      - {concept: TransferDebits, operation: create}
    instructions: Resolve both accounts before calling. Name the account the money leaves as `source`.
```

We publish `affects` as you wrote it and nothing more. Whether `TransferDebits`
is an entity or an edge is not stored: a consumer that needs to know reads it
off your model, which is the one thing that can say so correctly after a rename.

Remove an action from your document and the next push deletes its entry, because
your model owns the `<model>.actions.` id prefix. A catalog search can list the
actions in a project by entry type, the way it lists entities or metrics.

`semantic-action` is a custom entry type, because Dataplex has no built-in type
for an action yet. Run `kcmd init --semantic-model` once before you push a model
that declares actions, and it provisions the entry type and its aspect type in
your own project.

Publishing an action needs the permission to attach its aspect, on top of the
permissions any push needs — see
[Reference → Permissions](reference.md#permissions).

## 6. Pull it back

```bash
kcmd pull
```

Pull collects the `semantic-action` entries under your model entry and rebuilds
each action, so a name, a description, an executor, typed parameters, its
`guards`, its `affects`, and `ai_context.instructions` survive the round trip
unchanged. [What push and pull preserve](fidelity.md) lists which parts of a
model survive that trip and which do not.

## 7. Run it

An action with a `sql` executor is a write kcmd can perform for you. Two
commands:

```bash
kcmd action list
kcmd action run TransferFunds --arg source="Alice Checking" \
    --arg target=ACC-2 --arg amount=250
```

That second command does not succeed against the model built up on this page.
`TransferFunds` is guarded by an expression, and
[an expression guard refuses the call](#why-a-guarded-action-is-refused). What
follows describes an action that names no guard;
[a guard stated in words](#a-guard-settled-in-words) is the kind that runs
today.

`kcmd action list` shows what your model declares as runnable — parameters,
executor, guards, blast radius — and each entry ends with the command line that
runs it, so reading the listing is enough to make the call:

```
Model 'payments' (payments_eg), profile 'operational':
  store: my-project/my-instance/semantic_agent_demo
  TransferFunds: Move money from one account to another.
    parameters: source (Account, reference), target (Account, reference), amount (Float)
    executor:   sql
    guards:     AmountIsPositive
    affects:    Account (modify), Transfer (create), TransferDebits (create)
    run:        kcmd action run TransferFunds --arg source=<Account> --arg target=<Account> --arg amount=<Float>
```

### How a row is identified

An entity-typed parameter takes an object reference rather than a value, so
`--arg source="Alice Checking"` has to become one specific row before anything
can run. Two separate things decide which rows your action touches, and
conflating them is the easiest way to misread what an action does:

```
              resolving an argument     targeting the write
              ───────────────────────   ──────────────────────────────────
  what        --arg source=             the statement's own WHERE clause
                "Alice Checking"
  who runs    kcmd, before the write    the store, in the transaction
  how many    a single row, or          however many rows it matches;
              the call fails            kcmd does not constrain it
  gives       @source = 7               the rows the write lands on
```

*Table 3: resolving an argument and targeting the write are separate steps, run
by different components.*

**Resolving an argument.** For each entity-typed parameter, kcmd runs one lookup
against that entity's table before the write:

```sql
SELECT account_id FROM account
WHERE account_id = @ref0 OR name = @ref LIMIT 2
```

We build the `WHERE` from two things your entity declares:

- **Its `primary_key`.** `Account` declares `primary_key: [accountId]`, and
  `accountId` is bound to the column `account_id`, so we compare the input
  against that column. This answers "how does it know which column is the key" —
  your model says so, and we infer nothing from the database. One argument
  cannot name a key of several columns, so an entity keyed that way is reachable
  only through the identifying field below.
- **An identifying text field, if your entity has one.** That means a `String`
  field that is not part of the key, bound to a plain column, and *named*
  `name`, `full_name`, `title`, `label` or `display_name`. `Account` declares
  `name`, so `"Alice Checking"` and the account id both find the same row. We
  match on the field's name in your model rather than the column's name in your
  store.

We compare the input against each column as that column's own type, so a key
declared `Integer` is compared only when the input is a number. `"Alice
Checking"` is not, so we drop that predicate rather than cast it. If nothing is
left to compare, we send no query at all.

One row has to come back, and one only. No match gives you `No Account matches
'Alice Checking'.` Two or more rows are ambiguous, so we list the candidates by
key and you pick one. A name is not required to be unique, so two accounts can
carry `Alice Checking`:

```
Error: 'Alice Checking' matches more than one Account (7, 12); use a key to
disambiguate.
```

We report both rather than guess, because both are things you can act on.

**Targeting the write.** Resolution produces a *value*, which your statement
then uses. How many rows that statement lands on is its own `WHERE` clause's
business, and nothing would stop one that hits every dormant account. `affects`
does not limit the blast radius either — it *declares* it, so that a reader
knows what the write is about and an evaluator can one day check the statements
against what you declared.

`kcmd action run` does three things:

```
  kcmd action run TransferFunds --arg source="Alice Checking" --arg amount=250
     │
     │ resolve   SELECT account_id FROM account
     │           WHERE account_id = @ref0 OR name = @ref LIMIT 2
     │           a single row, or the call fails            ──▶  7
     │
     │ bind      @source = 7      as Integer, the key's declared type
     │           @amount = 250    as Decimal, so 9 is less than 10
     │
     │ apply     BEGIN
     │             UPDATE account SET balance = balance - @amount
     │               WHERE account_id = @source
     │           COMMIT
     ▼
   committed      ·      nothing written      ·      unknown, do not retry
```

*Figure 3: kcmd resolves each entity argument to a key, binds every value as a
typed parameter, and applies the statements in one transaction.*

We interpolate nothing into a statement. Every argument goes in as a query
parameter, and the argument's declared ontology type decides the store type that
parameter takes. Any failure before the commit rolls back, so no partial write
survives, and a commit your store *refuses* wrote nothing either. The commonest
refusal is Spanner's `ABORTED` under lock contention, and the answer to it is to
run the action again.

The third outcome is the one kcmd cannot settle: a timeout or a 5xx, where your
store may have applied the write and lost the response. We report that as
unknown rather than as a rollback. A caller who reads "nothing happened" would
retry a write your store had in fact applied.

Where the write goes is your model's Spanner deployment target under the
selected profile. The command line never names a database. Use `--profile` to
change the store, and [push](profiles.md) follows the same rule.

Only a `sql` executor runs. An `mcp`, `rest` or `grpc` executor names an
operation in another system, which kcmd cannot call and could not roll back if
the commit failed, so we refuse rather than half-perform the write:

```
Error: Action 'TransferFunds' is executed by MCP, which runs outside this
transaction and could not be rolled back if the commit failed. Supply a handler
that performs the write as DML, or declare the action with a 'sql' executor.
```

### Why a guarded action is refused

No component here evaluates an expression against live data. A runtime that
quietly ignores a rule your model declares is worse than no runtime at all,
because your model states that the write is checked and nothing says otherwise.
So `kcmd action run` refuses such a call instead:

```
Error: Action 'TransferFunds' is guarded by 'AmountIsPositive', and this runtime
does not evaluate constraints yet. Running it would apply a write the model says
must be checked first, so it is refused rather than run unchecked.
```

Only `guards` makes a call one of these, which applies
[section 2](#2-gate-it-with-a-constraint)'s rule here. If your action does not
name a constraint, this call does not consult it, and the runtime does not go
looking for one. Otherwise publishing a rule could start refusing calls that
succeeded the day before.

The exception is a constraint declaring `onViolation: warn`. An advisory rule
reports a violation rather than rejecting one, so gating on it would
permanently block every run of a model that states advisory rules.

We decide every refusal before opening a session, so a refused action leaves no
transaction behind.

### A guard settled in words

A guard stated as a `judgment` needs something that can read a sentence, and
`--judge` supplies one: Gemini on Vertex AI, reached with the project and the
credentials kcmd already holds.

```bash
kcmd action run IssueCredit --arg order=12347 --arg amount=5 \
    --arg memo="customer asked for a credit" --judge
```

That call runs against a commerce model carrying the credit policy from
[section 2](#a-policy-whose-rules-end-differently). A profile binds
`IssueCredit` to a `sql` executor, so kcmd performs the write itself, and the
action's `guards` name the judged rule alone.

Leave the flag off and the rule stops the call, because you supplied nothing to
settle it:

```
Error: Action 'IssueCredit' is guarded by 'CreditMemoNamesAServiceFailure',
which is settled by judgment rather than by an expression, and this runtime was
given no judge to ask. Running it would apply a write the model says must be
checked first, so it is refused rather than run unchecked.
```

Add the flag and the rule's own sentence goes to the model together with the
attempted call. The verdict comes back with a reason, and this constraint
declares `reject`:

```
Running 'IssueCredit' on projects/my-project/instances/my-instance/databases/semantic_agent_demo...
  rules stated in words go to gemini-2.5-flash (us-central1)
Error: Action 'IssueCredit' is guarded by 'CreditMemoNamesAServiceFailure'
("LineItem.memo must name a specific, verifiable service failure on the order: a
late delivery, a damaged item, a shipping charge applied in error. A memo that
states only that the customer requested a credit does not satisfy this rule."),
and gemini-2.5-flash (us-central1) judged that it does not hold for this call:
Your memo 'customer asked for a credit' does not name a specific, verifiable
service failure as required by the rule. Say what went wrong with the order in
the credit memo. No transaction was opened, so nothing was written.
```

Four things are in that message and kcmd wrote none of them: the constraint's
name, your own sentence, the judge's reason, and the constraint's `description`,
which is the line telling the caller what to do instead. A memo that names a
failure gets the write:

```
Running 'IssueCredit' on projects/my-project/instances/my-instance/databases/semantic_agent_demo...
  rules stated in words go to gemini-2.5-flash (us-central1)
  order: '12347' -> Order 12347
Committed at 2026-09-14T06:06:38.679692Z.
```

**We settle the rule before opening the transaction.** A model call takes
seconds, and holding write locks across one costs more than it buys, so the
order is: ask the judge, refuse with nothing touched, then open the transaction.
Two things follow. No judge sees the state that the write produces, so a rule
about that state has to be an expression. And a judge reads committed state, so
two calls racing each other can each be allowed against a total that neither
will leave behind — a rule that has to hold under concurrency is an expression
too.

**We give the judge the attempted call.** It receives the rule's text, the
action's name and description, and the arguments as the caller stated them —
`order=12347` rather than the `Order` row that value resolves to. That is the
whole of what it has, unless your run also passes `--judge-reads-store`.

**The routing word decides what a verdict does.** `on_violation` is the same
field [section 2](#2-gate-it-with-a-constraint) describes, and a judge's verdict
enters it the way any other breach does. A rule declaring `escalate` stops the
call and adds one sentence: "The model marks this rule 'escalate', so an
approver may allow it; nothing here can." Nothing in kcmd is an approver, and a
refusal that left this out would read as the end of the matter. A rule declaring
`warn` lets the write through and reports the verdict:

```
Running 'IssueCredit' on projects/my-project/instances/my-instance/databases/semantic_agent_demo...
  rules stated in words go to gemini-2.5-flash (us-central1)
  order: '12347' -> Order 12347
Warning: 'CreditMemoNamesAServiceFailure' ("LineItem.memo must name a specific,
verifiable service failure on the order: ...") is advisory, and
gemini-2.5-flash (us-central1) judged that it does not hold for this call: Your
memo "customer asked for a credit" does not name a specific, verifiable service
failure, which is required by the rule.
Committed at 2026-09-14T06:02:40.218987Z.
```

**A rule nobody could ask about is reported as unchecked.** Whether you supplied
no judge or the model call failed, nothing was learned about the rule, and
`on_violation` routes that as it routes a breach. An advisory guard lets the
write through and warns, naming the rule and ending "was not checked: this run
was given no judge to ask". Committing in silence would tell you every rule
passed when one was never put to anybody. A guard declaring `reject` or
`escalate` stops the call. We report expression guards the run skipped the same
way, one warning line each, because supplying a judge settles no expression.

**Status: an expression guard that refuses stops the call before any judge is
asked.** An expression declaring `reject` or `escalate` refuses the action above
and no model is reached; one declaring `warn` stands down, and the run reaches
the judge and commits, with a warning line for the expression nothing checked.
Three of the five guards
[section 2](#a-policy-whose-rules-end-differently) puts on `IssueCredit` are
expressions declaring `escalate` or `reject`, so the runs here guard on the
judged rule alone — which is also why they load with the all-judged warning.

### A guard that reads a row

Some rules cannot be settled from the call alone. *The credit must not exceed
the total of the order it is applied to* compares an argument against a number
in your database, and the caller is under no obligation to state it correctly.
`--judge-reads-store` sends the judge to read it.

Two things have to be in place. The flag says what a judge may do rather than
hiring one, so pass `--judge` alongside it. And your profile has to bind the
entities the rule talks about to tables, because that binding is the whole of
what we tell the judge about your database; with nothing bound, the run stops
before it starts and says so.

Then write the rule so the judge goes and looks — it decides that for itself,
from the sentence you give it. This is the rule the demo under
`demo/semantic-model/agent` states at the head of `IssueCredit`:

```yaml
- name: CreditWithinOrderTotalWithJudge
  judgment: >-
    The credit amount requested must not exceed the total of the order
    it is applied to. The `order` argument of this call identifies that
    order, and the order's total is on record rather than stated in the
    arguments, so read it before answering. Read both as dollars.
  on_violation: escalate
  description: >-
    A credit cannot exceed the total of the order it credits. Lower the
    credit amount, or split it across the orders it actually covers.
```

A run carrying the flag says the judge may read, and prints every statement it
sends:

```bash
kcmd action run IssueCredit --judge --judge-reads-store \
    --arg order=12345 --arg amount=3.00 \
    --arg memo="Shipping charge applied in error"
```

```
Running 'IssueCredit' on projects/my-project/instances/my-instance/databases/semantic_agent_demo...
  rules stated in words go to gemini-2.5-flash (us-central1)
  it may read commerce's tables to settle them
  the judge reads: SELECT total FROM Orders WHERE order_id = 12345
  order: '12345' -> Order 12345
Committed at 2026-09-15T03:39:42.804901Z.
```

Nobody wrote that statement: the judge composed it from the rule's sentence and
the tables your profile binds. kcmd prints every one, because a read made on
your behalf is yours to check.

**What the read buys you is a verdict the caller cannot argue with.** The same
order again, a credit of $200, and a memo asserting the order is worth $900:

```
  the judge reads: SELECT total FROM Orders WHERE order_id = 12345
Error: Action 'IssueCredit' is guarded by 'CreditWithinOrderTotalWithJudge'
("The credit amount requested must not exceed the total of the order it is
applied to. ..."), and gemini-2.5-flash (us-central1) judged that it does not
hold for this call: The credit amount of 200.00 exceeds the order total of
162.85. The model marks this rule 'escalate', so an approver may allow it;
nothing here can. A credit cannot exceed the total of the order it credits.
Lower the credit amount, or split it across the orders it actually covers. No
transaction was opened, so nothing was written.
```

The judge read the row, compared the argument against $162.85, and paid no
attention to the $900 in the memo. Drop the flag and the same call is refused
for the opposite reason: the judge says it cannot get the total.

**The judge sees what your model declares.** The entities, tables and columns in
its instructions come from your binding profile, so a column your model does not
bind is one we never tell the judge exists. The dialect comes from there too:
the rule above produces GoogleSQL against `Orders.total` under a Spanner profile
and PostgreSQL against `purchase_order.order_total` under an AlloyDB one.

**A judge cannot write.** Every statement has to be a single command beginning
with `SELECT` or `WITH`, and what reaches your store is that text wrapped as
`SELECT * FROM (...) AS judge_read LIMIT 21`, which the server refuses unless it
really is a query. That wrap stops short of a query calling a function that
writes, so give the action credentials no wider than the tables your model
binds.

**Keep the rule settleable from a few rows.** At most 20 rows come back, each
value clipped at 200 characters, and we tell the judge when its answer was cut
short. A rule needing a scan, a join across the history, or a total of its own
belongs in an `expression`.

**Reading costs model calls.** Asking and answering cannot be the same request,
so a guard with a store attached costs two calls rather than one even when it
reads nothing, and each further round of reading adds one more. The demo's four
judged guards read once between them and cost nine calls.

The race described under
[a guard settled in words](#a-guard-settled-in-words) applies here too, and
reading does not change it: the judge reads committed state, before the
transaction opens.

## 8. Hand it to an agent

Here is what the previous seven steps were for. An agent needs two things from
your model: a way to find what is there, and a way to change it. Your entities
already say what can be looked at and your actions already say what can be done,
so you write neither half by hand. One command prints what an agent would be
handed:

```bash
kcmd agent tools
```

Run it against the model built up on this page and it prints the listing below.
Reading your model is all it does: it opens no session, calls nothing, and
changes nothing.

```
Model 'payments' (payments_eg), profile 'operational':
  store: my-project/my-instance/semantic_agent_demo

  action  transfer_funds  (TransferFunds)  [NOT RUNNABLE]
      Move money from one account to another.

      Resolve both accounts before calling. Name the account the money leaves
      as `source`.

      This call is gated by AmountIsPositive.

      Calling this will not work: Action 'TransferFunds' is guarded by
      'AmountIsPositive', and this runtime does not evaluate constraints yet.
      Running it would apply a write the model says must be checked first, so
      it is refused rather than run unchecked. Report that rather than
      retrying.
      source: string -- Which Account this applies to. Give its key, or text
          that identifies exactly one; the call fails when nothing matches or
          more than one does.
      target: string -- Which Account this applies to. Give its key, or text
          that identifies exactly one; the call fails when nothing matches or
          more than one does.
      amount: number -- The amount, as a number.

  lookup  find_account  (Account)
      A customer's money at this bank.

      Returns accountId, name, balance, minimumBalance, status. Every argument
      is an exact match and every one is optional; giving none returns the
      first rows. This tool cannot join, compare ranges, or total anything.
      accountId: integer
      name: string
      balance: number
      minimumBalance: number
      status: string -- open, frozen or closed.

  lookup  find_transfer  (Transfer)
      One movement of money between two accounts.

      Returns transferId, amount, debitedId. Every argument is an exact match
      and every one is optional; giving none returns the first rows. This tool
      cannot join, compare ranges, or total anything.
      transferId: integer
      amount: number
      debitedId: integer

  instruction:
      Never move money between two accounts held by the same customer without
      saying so in your answer.

      Never invent an identifier. When you are given a name or a description
      instead of one, find it with the lookup tools rather than asking for it
      -- that is what they are for, and asking wastes the caller's time. Never
      compute a total or a balance yourself; the tools do that. When a tool
      reports that a write did not happen, read the reason it gives and repeat
      it plainly; if it says a person has to decide, say so and stop, because
      you cannot approve it yourself. Finish by saying what you changed.
```

That is three things — one **write tool** for the action, one **lookup tool**
for each entity, and one **instruction** for whatever agent holds them. Every
line of it comes from a key in one of your two files, and each key produces one
thing:

```
  the model                              what the agent is handed
  ─────────────────────────────────      ───────────────────────────────────
  actions:
    - name: TransferFunds          ───▶  action  transfer_funds
      description: Move money…     ───▶      Move money from one account to
                                               another.
      ai_context:
        instructions: Resolve…     ───▶      Resolve both accounts before
                                               calling.
      guards: [AmountIsPositive]   ───▶      This call is gated by
                                               AmountIsPositive.
      parameters:
        - name: source
          type: Account            ───▶      source: string -- Which Account
                                               this applies to. Give its key…
        - name: amount
          type: Float              ───▶      amount: number -- The amount, as
                                               a number.

  entities:
    - name: Account                ───▶  lookup  find_account
      description: A customer's…   ───▶      A customer's money at this bank.
      fields:
        - name: accountId
          datatype: Integer        ───▶      accountId: integer
        - name: status
          description: open,…      ───▶      status: string -- open, frozen
                                               or closed.

  ai_context:
    instructions: Never move…      ───▶  instruction:
                                             Never move money between two
                                             accounts held by the same…

  the binding profile                    what the agent is handed
  ─────────────────────────────────      ───────────────────────────────────
  deployment_target                ───▶  store: <project>/<instance>/<db>
  entities[].source                ───▶  the table a lookup reads
  fields[].expression              ───▶  the column it filters on
  actions[].executor               ───▶  what the write tool runs
```

*Table 4: which key in your model or your profile produces each line of the
agent listing.*

Two lines come from neither file. `[NOT RUNNABLE]` and the paragraph under it
are the runtime's answer to whether this call could succeed. The second
paragraph of the instruction is the derivation's own text about using the tools,
identical for every model.

Nothing in the listing was written for a particular agent, which is the property
worth being able to see: it reads the same whether your caller is ADK,
LangChain, or a person deciding whether the model says enough yet.

### What the two kinds of tool do

A **write tool** runs the action. Invoking `transfer_funds` performs the same
resolve, bind and transact that [`kcmd action run TransferFunds`](#7-run-it)
performs, with the same argument resolution, the same single transaction and the
same three outcomes.

A **lookup tool** reads one entity: exact match on any bound field, combined
with AND, capped at 50 rows. It cannot join, compare ranges, aggregate or order.
That is enough to turn `"Alice Checking"` into the account id your write tool
needs, and it keeps the generated SQL checkable by eye. Table and column names
come from your binding and every filter value is a bound parameter, so no caller
text reaches the SQL.

A lookup is named for its entity, and an action keeps its own name when the two
collide. An entity named `Account` and an action named `FindAccount` both derive
`find_account`. The action takes that name, because you wrote it, and the lookup
becomes `lookup_account`. Deriving both halves together is what lets us notice
the collision at all.

### A tool says whether it can be called

`transfer_funds` above is listed and marked `[NOT RUNNABLE]`. `TransferFunds`
names a guard stated as an expression, nothing here evaluates one, and so we
report the [refusal from section 7](#why-a-guarded-action-is-refused) here
instead — before any agent exists, rather than inside a transaction.

We mark an action guarded by a judgment the same way when the derivation holds
no judge, and for the same reason: what we report is what the runtime *would* do
with what it is holding, and with no judge it would refuse. Supply one, and the
same action is offerable, with the same description and the same parameters:

```console
$ kcmd agent tools --judge
Rules stated in words go to gemini-2.5-flash (us-central1).
...
  action  issue_credit  (IssueCredit)
```

The flag takes an optional model name, the same way [`kcmd action run
--judge`](#a-guard-settled-in-words) does. The flag does not call a judge. A
judge settles a rule when an action runs, and printing what an agent is offered
runs no action, so this listing costs you nothing however many guarded actions
it names.

The judge belongs to the derivation rather than to each invocation, which is the
one place this is easy to get wrong. Whether a guarded action can be offered *at
all* depends on holding a judge, so the same object has to answer `runnable` and
answer the call. A tool derived with a judge and then invoked without one would
be advertised as callable and refused mid-call, which is the drift the next
paragraph is about.

We still return the tool, still named and still described. An action that your
model declares should not vanish from the set your model offers, and the useful
thing to print is what that action is waiting on. Both halves carry a
`runnable` flag, and `unavailable` carries the reason:

| A write tool is withheld when | A lookup is withheld when |
|-------------------------------|---------------------------|
| a profile withdrew the executor | the entity is abstract, so it has no table |
| the executor is remote and no handler was supplied | no profile bound it to a table |
| it names a guard, as above | its binding is a query rather than a table |
| a parameter references an entity keyed by several columns | |
| the statements ask for a generated key a UUID cannot fill | |

*Table 5: the conditions under which we withhold a write tool or a lookup
tool.*

The derivation asks the runtime for that verdict rather than working it out
again, so the two cannot drift. Drift costs you something in both directions. A
tool that is advertised as runnable but refuses every call spends your agent's
turn and teaches it nothing. A tool withheld that would have worked is never
discovered at all.

### Calling it from code

`kcmd agent tools` prints the derivation; `modelTools` returns it. Both take a
**semantic runtime**: one model paired with the store your profile binds it to.
`createSemanticRuntimes` assembles them the way `kcmd action` does, so your
agent reads the model the CLI reads, under the same profile, with the same merge
and the same warnings:

```ts
import {createSemanticRuntimes} from './src/libts/semantic/runtime/runtime';
import {modelTools, callableTools} from './src/libts/semantic/runtime/agent_tools';

const runtimes = await createSemanticRuntimes({profile: 'operational'});
if ('error' in runtimes) throw new Error(runtimes.error);

const runtime = runtimes[0];
if (!runtime.store) throw new Error(runtime.storeError);

const {callable, withheld, instruction} = callableTools(modelTools({runtime}));
```

`modelTools` also takes `judge`, and passing one is what makes an action guarded
by a judgment callable at all. `GeminiJudge` implements the seam over Vertex AI;
anything with a `decide` method does. Omit it and we still derive such an
action, still named and still described, and report it in `withheld`.

One call returns a runtime for every model document in your entry group. Each
runtime carries the store that its deployment target names, the profile it was
built under, and the document it was authored in, so a message about one model
can say which file and which profile produced it.

A store is typed by its backend: `runtime.store.kind` is `'spanner'` or
`'bigquery'`, and only a Spanner store can be written to. A model whose profile
binds no store at all still gets a runtime, with `storeError` saying why. We
still derive its tools, each marked unavailable for that reason, so your agent
is told what the model offers and why it cannot reach it.

Go through `createSemanticRuntimes` rather than building a client yourself. It
is also the check that every entity is bound to a table in the store your
profile targets. Without it, a model could be bound to some other system, and a
lookup derived from that model would read whatever table of that name your
target store happens to hold.

`modelTools` returns `{lookups, actions, instruction}` — the three things the
listing printed. `callableTools` then sorts both halves into the ones this
binding can serve and the ones it cannot, which is a split every adapter has to
make and the same split every time. Offer `callable` to your agent, and report
`withheld` rather than hiding it. We export `actionTools` and `entityTools` for
a caller that wants one half.

Each tool is a name, a description, typed parameters and `invoke(args)`, so
binding one to ADK, to LangChain or to an MCP server is a short adapter over
that shape, and a second framework costs you nothing here. Nothing in this
module imports an agent framework.

`invoke` answers with three states. A write that landed and a write that did not
are the obvious two. The third is a commit whose result nothing can establish,
which we report as unknown with an explicit "do not retry", because a caller
reading it as "nothing happened" applies the write twice.

Pass `handler` for an executor this runtime cannot perform itself. We do not
pass it to an action with a `sql` executor. Such an action claims that what runs
is what the catalog published, and one handler serves the whole model, so
passing it through would retract that claim for every such action at once.

### The instruction is not the agent's to write

The instruction at the foot of the listing has two parts, because two different
people own them.

One part is your model's own `ai_context.instructions` — what this business asks
of anything that acts on it. It belongs to the model because it is true of every
agent that acts on the model, including the ones nobody has written yet. It also
belongs there because an agent can keep a rule in its own source, and someone
can change that rule without the people who own the model finding out. Agents
are replaced when frameworks change; your model is not.

The other part is about the tools rather than the business: what a lookup is
for, and what a refused write means. The derivation owes that half, because it
describes a contract this module defines and your model never stated. Written
into each agent instead, it is the same paragraph copied into every adapter,
drifting in each one.

So an agent that appends a persona of its own is saying something your model did
not. Put it in the model.

### A worked example

`demo/semantic-model/agent/` is an agent built this way, running against a live
operational store: a commerce model, a binding profile, and one file of 72 lines
that names no table, no column, no business term and no dollar threshold.
Thirteen of those lines are the adapter onto the agent framework. Its README
walks the same steps and reaches all three of `on_violation`'s outcomes against
that store: a $30 credit held because the model's $25 self-service ceiling is
`escalate`, a credit written with a warning because the memo names no service
failure, and a credit refused outright because the memo admits it is one piece
of a larger amount.

It also states what that costs and what it cannot do. The model guards on four
judgments and the judge it hires can query the store, so the demo loads with the
all-judged warning and pays two model calls per guard, plus one for each round
of reading. That came to nine calls in the run its README captures. One rule is
declared and not enforced: an order's total matching its line items is a
statement about the state the write leaves behind, and guards settle before the
write. And the split-credit rule fires only because the model tells callers to
disclose a split in the memo, which makes it a check on honest mistakes rather
than a control. The version that would hold regardless counts the credits
already on the order, which a reading judge could do and this model does not ask
it to.

## What is not modeled yet

This is a prototype. Three things you might reasonably expect are absent.

- **We check only a rule stated in words.** `kcmd action run --judge` settles a
  guard whose constraint carries a `judgment`. No component evaluates an
  expression against live data, and we refuse an action guarding on one rather
  than run it. The gap is loud where your model states that a rule gates the
  call, and it is still a gap. Whoever wrote a statement owns the correctness of
  what it does.
- **kcmd calls no executor but its own.** A `sql` action runs; an `mcp`, `rest`
  or `grpc` one is published for whoever dispatches it, which is why those three
  name coordinates rather than a statement.
- **The store is Spanner or AlloyDB.** `kcmd action run` resolves, binds and
  transacts against the database your profile's deployment target names, which
  may be either of those. A model bound to BigQuery publishes its actions and
  runs none of them.
