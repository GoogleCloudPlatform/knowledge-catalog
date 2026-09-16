# Modeling write operations

Your semantic model already tells an agent what your data means and which
questions it can ask. Ask that agent to *do* something — refund an order, move
money between two accounts, close a dormant account — and the model has nothing
to say. The write exists somewhere, as a service call or an endpoint or a few
lines of DML, but it's visible only to whoever built the service around it. Your
agent either can't reach it, or reaches it through a hand-written tool that your
model never sees and can't govern.

An **action** closes that gap. It's a named write operation declared over the
same concepts as the rest of your model: you give it a name, type its inputs
against your ontology, and say which concepts a call changes. Publishing it puts
the operation in the same place as the data it acts on, so an agent that
discovers your model discovers what it can change there as well as what it can
ask.

One part of an action is physical — how the write actually happens. That part
lives in a field called the **executor**, which names an MCP tool, a REST
endpoint, a gRPC method, or DML. Keeping it separate lets a binding profile
supply it, so you write an action across two files. Your model names the
operation and its parameters; a binding profile names the tables, the columns,
and the executor. kcmd combines the two into one bound model.

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

The rest of this guide follows one action — moving money between two bank
accounts — from a name in your model through to an agent that can call it. A
second example, a customer-service credit, comes in once the rules get harder to
write.

## When to use an action

Declare an action when the write already exists. Somewhere in your organization
there's a service call, an endpoint, or some DML that moves this money or issues
this credit. Declaring it as an action doesn't reimplement any of that — it
tells everything that reads your model that the operation is there, what it
takes, and where it lives.

If the call should hand back an answer instead of changing something, you want a
[metric](README.md#1-author-the-logical-model) instead.

## 1. Declare the action

Start with the name and the parameters. They're the contract every later step
builds on, and they live in your model and nowhere else — no profile can change
them.

Actions sit at model level, beside your metrics. Each one carries a name, its
parameters, and an executor. Treat that executor as a default, because it's the
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
          - { name: transferId, datatype: String,  expression: transfer_id }
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
the relationships — the way you would for any model. See
[Deploying a semantic model](README.md).

The executor tells a consumer where the operation lives. Pick one of these four
kinds, and give any one executor a single kind only:

- **`mcp`** — `{server, tool}`. A tool you've already registered in Agent
  Registry, named by the server's resource name and the tool's name within it.
- **`rest`** — `{endpoint, method}`. An HTTP endpoint and the verb to call it
  with.
- **`grpc`** — `{service, method}`. A service and the method on it.
- **`sql`** — `{statements}`. The write itself, carried in your model instead
  of named as a pointer to whoever performs it, and the only kind kcmd runs.
  See [carrying the write as DML](#carrying-the-write-as-dml).

Both `description` and `ai_context.instructions` travel through to the catalog.
Write those instructions for the agent that's going to call the action, the way
the example does.

### Parameters typed by an entity

A parameter's type can name an entity from your model instead of a datatype.
Writing `{name: source, type: Account}` says the argument refers to an account,
so a consumer generating a tool schema knows to accept an identifier and
resolve it against `Account`'s key rather than pass a bare number through. A
parameter typed by a datatype, like `amount` above, is an ordinary value and
refers to nothing.

### Where the executor comes from

Everything else your action declares is logical: what it takes, what gates
it, what it changes. The executor isn't, because *how* the change gets
carried out depends on where your rows live. kcmd therefore treats it as a
physical binding, like an entity's `source`, so a [binding
profile](profiles.md) can supply one or replace the one your model declares.
An action a profile says nothing about keeps the executor the model gave it.

Sometimes nobody has wired the write up yet, or another team owns it and you
need your model only to record that it exists. Leave the executor out of both
files for that case. Your action is then **declared but not performable**: it
still states what it does, what gates it, and what it changes, which is the
whole of what a reader needs. A catalog-only push — `--no-profile`, or a model
with no deployment target — publishes it like any other action, and `kcmd
profiles` lists it under `cannot run:` for each binding that supplies no
executor for it.

## Carrying the write as DML

The first three kinds name a system that performs the write, which leaves the
write itself opaque to your model: an `mcp` tool name says where the operation
lives and nothing about what it touches. A `sql` executor carries the write
instead, so what your action does becomes readable — and checkable — from the
model, and kcmd can [run it](#7-run-it) rather than handing the write to another
system to perform. Written into the model, it replaces the `mcp` executor
`TransferFunds` declared above:

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

`statements` is a list because one business action is often more than one write.
The transfer above debits one account and credits another, and a transfer that
did only the first would lose money. kcmd opens one transaction, runs the
statements in the order you wrote them, and commits at the end, so two writes
that only make sense together never apply by halves.

Carrying the write buys you two things:

- **Your blast radius is checkable.** A reader can compare `affects` against the
  statements instead of taking it on trust.
- **A guard becomes a real gate.** An MCP, REST or gRPC call commits inside a
  system kcmd doesn't control, so a write it performed can't be rolled back if
  the rest of the action fails. A `sql` action's guards settle before kcmd opens
  a transaction, and a call that doesn't clear them never reaches one, so a
  refusal leaves the store untouched.

### Statements use your database names

**An action's statements reach your store exactly as you wrote them**, so every
table and column in one has to be the name your database uses. In the `sql`
executor above, the model's `Account` and `accountId` appear as `account` and
`account_id`. Those are the table and the column that the entity's `source` key
and its fields' `expression` keys bind it to.

`@parameter` references are the exception: they name a value kcmd binds at call
time rather than anything in your database.

A statement that says `accountId` where the column is `account_id` still passes
push, because push never asks your store whether a table exists. The error comes
from the store when the action runs, and it can read like a fault in the
statement rather than a typo in a name. An entity named `Order` bound to a table
named `Orders` produces

```
Syntax error: Unexpected keyword ORDER [at 1:8]
```

instead of "no such table", because `ORDER` is a reserved word.

### Which file a `sql` executor belongs in

Because its statements name one database's own tables and columns, a `sql`
executor usually belongs in that database's profile rather than in the
model — unless your model will only ever have one store. An `mcp`, `rest` or
`grpc` executor names an operation in another system, and that name usually
doesn't change with the store, so it stays in the model the way `TransferFunds`
declares its `mcp` tool above.

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

This profile overrides the model's `mcp` executor for the one store that
performs the write as DML. Write `executor: null` instead to withdraw an
inherited executor, which leaves you a read-only binding that performs no
writes.

## 2. Gate it with a constraint

The sections so far declared an action and gave it a write to perform. This
section is how you stop it running when it shouldn't. A **constraint** is a
named rule your model states over its ontology. Declaring one adds it to the
catalog and changes nothing by itself. A constraint takes effect where
something references it and nowhere else, so publishing a rule can't quietly
start refusing calls that succeeded yesterday.

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

A constraint states its rule in one of two bodies: an `expression`, when a query
over your ontology decides the question, or a `judgment`, when no query can.
Which one you wrote shows up on the published constraint as a derived
`evaluation` field reading `deterministic` or `judged`, so a consumer can select
on it.

### Naming a constraint as a guard

An action's `guards` list is what puts a constraint to work. Declare the rule,
then name it on the action — one line on the `TransferFunds` from section 1:

```yaml
    constraints:
      - name: AmountIsPositive
        expression: amount > 0
        description: >-
          A transfer must move at least one unit. Ask the caller for the
          amount again before retrying.
    actions:
      - name: TransferFunds
        guards: [AmountIsPositive]
```

`guards` holds the names of constraints your model declares, and listing one
there is what makes it apply to that action. Both kinds of body go in the same
list. Put the reference on the action rather than on the constraint, because the
same rule may gate `TransferFunds` and leave `CloseAccount` alone.

Whatever dispatches the call is what checks its guards, and it checks every one
of them before the call, with the arguments bound and before any transaction
opens. Nothing in your model binds a rule to the state a write leaves behind, so
a guard reports on the arguments it was handed and on the data the call starts
from, and on nothing else.

`guards` and `on_violation` are independent, the way the two right-hand columns
of figure 2 are: one says when the constraint gets checked, the other says what
a breach does. So guarding a constraint that declares `warn` is a real shape.
Your organization may not be ready to block on a rule; guarding it anyway still
gets the rule checked at the moment of the call and reported back.

When one call violates several guards, the strictest outcome applies. Any
`reject` refuses the call, failing that any `escalate` holds it, and failing
that any `warn` lets it through with the violations reported. The precedence is
fixed and nothing in your model states it, so an action can name any number of
guards without you writing down how they combine. It is also how `forbid`
overrides `permit` in Cedar and how a deny wins in Open Policy Agent, so a
policy written this way lowers into either.

kcmd reports a mismatch from either side. A guard that names no constraint fails
the push. A constraint over parameters that no action names loads with a
warning, because nothing will ever evaluate it. That scan reads expressions
only. A judgment is prose, and a word in it matching a parameter name is not a
read of that parameter.

### Rules a query settles

Write the rule as an `expression` when a query over your ontology decides it. A
condition over stored data names the entities and fields it reads:

```yaml
    constraints:
      - name: BalanceStaysPositive
        expression: Account.balance >= Account.minimumBalance
        description: >-
          An account cannot be taken below its minimum balance.
```

A condition over the action's parameters describes one call instead, the way
`AmountIsPositive` above reads `amount` and nothing else. A rule like that is
settled completely before the call, since the arguments are the whole of what it
reads. A rule over stored data is a condition on the state that a write
produces, so checking it before the call reports only that the call isn't
starting from a broken state. It says nothing about the state the call leaves
behind, and that gap is the difference between what a data rule says and what a
guard can enforce.

An expression can also go to your store rather than to whatever dispatches the
call, and that works for some rules and not others. A condition on a single row
lowers to a store-level `CHECK`. One that aggregates across a child table, such
as an order total matching the sum of its line items, lowers to neither Spanner
nor BigQuery.

**Status: no component evaluates an expression against live data.** kcmd parses
one, validates it, publishes it with the `guards` that name it, and reads it
back. At run time [`kcmd action run`](#7-run-it) refuses an action whose
`guards` name an expression rather than apply a write your model says must be
checked first.

### Rules no query settles

Your business enforces some rules that can't be written as a boolean. A credit
memo may or may not explain the failure it claims to refund. A discount may or
may not be justified by the reason given. In both cases a query can read the
text and can't settle the question. Write such a rule in `judgment` instead of
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
judgment must state `on_violation`, and any of the three words will do. Omit it
and the push fails, because an unmarked constraint would reject, and that's too
strong a consequence to inherit by silence.

No judge settles a rule about the state a write *leaves behind*. A guard runs
before the transaction opens, so "an order's total equals the sum of its lines"
has nothing to look at yet. Put that rule inside the transaction or in your
schema.

An action whose guards are *all* judged loads with a warning today. Every gate
then costs a model call, none can lower to a store-level check, and each may
decide two identical calls differently.

The warning doesn't mean you've written something wrong. Some operations really
are governed only by rules no expression settles, so an all-judged action can
be exactly right. The warning puts that cost in your source rather than leaving
you to find it in a published model. Whether a warning is the right response is
still open, so treat it as current behavior rather than a rule to design
around.

**Status: a judgment is the one body kcmd settles.** At run time,
[`kcmd action run --judge`](#a-guard-settled-in-words) puts each judged guard to
a language model and routes the verdict by `on_violation`.

### Writing a judgment

A language model reads your sentence at review time with the proposed write in
front of it. kcmd calls that reader the judge. Five habits make that reading
consistent:

1. **State what must be true of the data.** Write the condition — *the memo
   must name a specific service failure*, and not the procedure, *check whether
   the memo is specific*. Your sentence describes a clean write, and everything
   about handling a breach lives elsewhere.
2. **Name fields model-qualified.** Write `LineItem.memo` rather than "the
   memo". kcmd resolves every `Entity.field` token in the text against your
   model and fails the push when the entity declares no such field, so a rename
   can't leave your sentence pointing at nothing. The qualified name also tells
   the judge which value to read.
3. **Say what doesn't count.** A rule with no negative example gets graded
   against whatever the model guesses you had in mind. The sentence "A memo
   that states only that the customer requested a credit does not satisfy this
   rule" buys you more consistency than any further description of what a good
   memo is.
4. **Leave the consequence out of the prose.** What happens on a breach is
   `on_violation`. A judgment ending "…otherwise escalate to a supervisor"
   states a routing nothing reads, and the engine routes by the field
   regardless.
5. **Keep it to one condition.** When your sentence needs "and also", the
   second half is a second constraint. One `on_violation` can't carry two
   consequences, so two conditions that end differently can't share a
   constraint.

All five are about wording. Claim no more in the wording than a judge can
settle.

A judge settles a guard from the call's arguments and whatever it could read, so
a sentence about stored data can turn out to be a rule it has no evidence for.
The instructions tell it to refuse in that case and say what's missing, but that
instruction binds a model rather than the runtime, so the rule can come back
held instead — a guard that never fires and never says why. Phrase the condition
around the arguments the call carries, and try every judged guard against a case
it ought to refuse.

A rule that does need a stored row — comparing a credit against the order total,
say — is settled when you run with `--judge-reads-store`. Word it to say the
value is on record and has to be read, because the judge decides for itself
whether to look. The same rule refuses every call when it goes to a judge that
can't read. See [a guard that reads a row](#a-guard-that-reads-a-row).

## A credit policy, worked through

Real policies have several rules, and the rules rarely end the same way. A
support agent is about to issue a customer-service credit, and five separate
rules bear on whether they may:

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

Writing that policy down needs an `Order` with a `total`, a `LineItem` with an
`amount` and a `memo`, and an `IssueCredit` action taking the order, the amount
and the memo. Each rule becomes one constraint, and each states its own outcome
in `on_violation`:

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

Each `on_violation` key carries one branch of what your policy describes in
prose, in a form a search can read.

**Rule 3 declares `reject`, because it's the one rule here nobody in the
business may approve.** An order whose total disagrees with its line items is a
broken order rather than an unusual one. As a guard the rule reaches less far
than it reads. `IssueCredit` refuses to run against an order whose books already
disagree, and lets through a credit that would break the agreement itself.

**Rules 4 and 5 are the reason `judgment` exists.** Neither reduces to
arithmetic over `Order` and `LineItem`, so before a judged body there was
nowhere to put them but a policy document nothing links to. Not everything in
the policy has to move, though. The threshold in rule 2 is arithmetic, so it
stays an expression a query settles and no model call is spent on.

**Rule 5 is a judgment that declares `reject`.** Splitting a credit to evade
review is a rule the business means as unappealable, and no expression detects
it, so the alternative to writing it this way is leaving it out of your model.
The pairing carries a real cost, because a language model can decide two
identical credits differently and `reject` leaves nobody to appeal to. kcmd
publishes it instead of forbidding it, and makes it findable. Its `evaluation`
field reads `judged`, so an auditor asking which unappealable rules your model
settles gets an answer from one query.

### Two calls through the policy

Here are two calls against order 12345, which totals $165.85. One is a
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

The supervisor who gets the first call reviews a credit against an order
rather than a SQL diff. The second call is the case the judged rules were added
for. Every gate a query can compute lets it through, because each 9-dollar
credit sits under the order's total and under the 25-dollar ceiling on its own,
and only reading the three together as one 27-dollar credit puts them over it.

Three of `IssueCredit`'s five guards are expressions, so it stays clear of the
all-judged warning. The bottom row of table 2 applies the strictest-outcome
rule from section 2 — an `escalate` with nothing stricter beside it holds the
first call, and rule 5's `reject` decides the second.

**Status: a run doesn't compute the strictest outcome.** `--judge` puts the
judged guards to the judge in the order your model declares them and stops at
the first one that fails without being advisory. What comes back is that guard's
outcome rather than the strictest of them, and a `warn` collected on the way
there doesn't travel with the refusal. And [`kcmd action run`](#7-run-it) won't
perform `IssueCredit` as declared here, so the two calls above are what the
published policy says should happen rather than what kcmd does with this action
today.

## 3. Say what it changes

`affects` names the concepts a call writes to. An executor like
`mcp: {server, tool}` says where the operation lives and nothing more, so no
reader of your model can see what that tool writes; the blast radius of a call
stays unknown until you declare it here.

`affects` is a list, and every entry in it takes one of two shapes: a bare
concept name, or a record that also says how the concept changes.

**A bare name** says the concept is touched, in a way your model doesn't spell
out:

```yaml
        affects: [Account, Transfer]
```

That's enough to answer *which actions can change an account at all*, which is
already more than an executor name answers.

**A record** adds the operation and the fields the call writes:

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

You'll usually have worked some concepts out further than others. The two
shapes go in one list together, so a coarse entry on the ones you haven't costs
you nothing on the ones you have:

```yaml
        affects:
          - { concept: Account, operation: modify, fields: [balance] }
          - Transfer
```

`affects` declares the blast radius rather than limiting it. Naming one field
doesn't stop a statement from writing others, and naming two concepts doesn't
stop a call from touching a third; the list records what you mean the call to
do.

### What an entry may say

`concept` takes an entity or a relationship, written the same way for either
kind — your model already records which one it is. `TransferDebits` above is
the edge from the example model, and it sits in the list beside the two
entities. Either way the name has to be one the same model declares.

`operation` is `create`, `modify` or `delete`, the same three whatever the
concept is, and a fourth word means your document doesn't parse. Leaving it out
gives you the coarse form one entry at a time, covering every operation on that
concept. Two entries on one concept with the same operation are a hard load
error, and a bare entry beside one with an operation warns, because the bare
one already covered what the second narrows.

`fields` names what a `create` or a `modify` writes, which makes *which actions
can change `Account.balance`* answerable. A `delete` takes the whole instance,
so a field named beside one is rejected rather than ignored.

On a relationship, `fields` means the junction table's own columns, so *modify
the grade on an Enrollment* is as ordinary a change as *modify an order's
total*. A plain foreign-key edge carries no columns of its own, and
`TransferDebits` is one, so naming a field on it is an error — the property you
meant belongs to an endpoint entity.

Name the concept now and refine it later. Writing `- concept: Account` on its
own says the same thing the bare `Account` does, and it's written back as the
bare form.

**Status: nothing compares `affects` to what your executor does.** kcmd parses
it, checks the concepts against your ontology, publishes it and reads it back,
and no component reconciles the declaration with the statements or the tool
call. Two things beyond those checks read it. Resolving your model through a
binding profile drops any action affecting a concept the profile can't bind, so
that action never reaches the catalog. Publishing an action whose affected
concept has no entry in the same push warns you that the catalog now records a
blast radius naming something it can't resolve.

## 4. Check it before pushing

`kcmd push --validate-only` runs the checks a push runs and deploys nothing. It
loads your model, checks each action against the ontology that same model
declares, and prints every error it finds. A push clears the same gate before
it writes anything, so whatever this reports would have stopped your deploy:

```bash
kcmd push --validate-only
```

Once your document parses, four checks run over every action, and a failure in
any of them stops the push:

- **Every parameter's type resolves** — to an entity the model declares, or to
  a scalar datatype. A type that is neither leaves a caller guessing what to
  pass.
- **The executor has the fields its kind requires.** `server` and `tool` for
  `mcp`, `endpoint` and `method` for `rest`, `service` and `method` for `grpc`,
  at least one statement for `sql`. Leave one blank and whatever picks the
  action up has nothing to call.
- **Every name in `guards` is a constraint the model declares.** This is the
  one that costs you silently — a guard naming a constraint that doesn't exist
  gates nothing, so you believe the write is checked while nothing checks it.
- **Every `affects` concept is an entity or relationship the model declares.**
  The list exists to answer *which actions change `Account`*. A typo is
  invisible on the page and would drop the action out of that answer.

A model that breaks all four reports all four, one line each, and deploys
nothing:

```
Error: action 'TransferFunds' in model 'payments' (payments) has parameter
'target' whose type 'BankAccount' is neither a known entity nor a scalar
datatype.
Error: action 'TransferFunds' in model 'payments' (payments) has an mcp
executor whose 'tool' is missing or blank.
Error: action 'TransferFunds' in model 'payments' (payments) is guarded by
'AmountIsPostive', but model 'payments' declares no constraint of that name.
Error: action 'TransferFunds' in model 'payments' (payments) affects 'Acount',
which is neither an entity nor a relationship this model declares.
```

`AmountIsPostive` there misspells the `AmountIsPositive` the model declares, and
`Acount` misspells `Account` — the two typos a reader of the document would
skim straight past.

kcmd checks the rest of an `affects` entry just as strictly. Fields beside a
`delete` are a hard error, and so is a field the concept doesn't declare. An
operation outside `create` / `modify` / `delete` never gets this far — the
vocabulary is closed, so your document doesn't parse at all.

The two checks that read your ontology stand down when a binding profile
resolves your model. Resolving drops entities and relationships the profile
can't bind, so holding `affects` to the ontology there would fail your deploy
over a concept the profile removed rather than one you mistyped. An undeclared
concept and an undeclared field fall back to the warning the loader already
gave. A catalog-only push and `kcmd action run` read the author's model
whole, so both treat the same two as hard errors. Fields beside a `delete` read
only the entry, so that one fails everywhere.

### What push holds a statement to

kcmd checks a `sql` executor further than the other three kinds, because it
carries the write rather than a pointer to whoever performs it:

- Write each statement as a **single `INSERT`, `UPDATE` or `DELETE`**. A
  statement that reads is a query and belongs in a metric; one that reshapes the
  schema isn't an action. A `;` anywhere but the end is rejected, because each
  list entry runs on its own and anything after the separator would silently not
  run.
- **Every `@name` a statement binds has to resolve** to a parameter your
  action declares. Anything you write another way is left alone — a literal
  passes, and so does a SQL function. Nothing is interpolated into the
  statement text, so an argument can't become SQL.
- **You choose where a new row's key comes from.** Write `GENERATE_UUID()`
  into the `VALUES` list, pass the key in as an ordinary parameter, or, where
  the key column has a default, leave it out and let the store fill it. kcmd
  generates nothing on your behalf, and nothing in `affects` bears on the
  choice.
- **A key that arrives as an argument is a key the caller chooses.** An agent
  filling that parameter can name a row that already exists, and nothing in
  kcmd stops it, because the check on statement shape reads only the first
  word. An upsert therefore passes and overwrites. Spanner spells one
  `INSERT OR UPDATE` and AlloyDB spells one `INSERT ... ON CONFLICT`. A plain
  `INSERT` fails on the duplicate instead. Generate the key inside the
  statement unless something about the call needs the caller to pick it.
- Nothing else is available: no control flow, and no statement composed at call
  time. `statements` is a fixed list in your model, so an action whose body
  arrived with the call would declare nothing, and a gate can't check what was
  never declared.

## 5. Push it

```bash
kcmd push
```

Knowledge Catalog is the one system your action reaches. Each action becomes its
own entry there, parented to the model entry, the same way a metric does. The
entry carries one aspect holding the executor and the typed parameters:

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

`affects` is published exactly as you wrote it. The entry doesn't record
whether `TransferDebits` is an entity or an edge. A consumer that needs that
answer reads it off your model, the only place that still answers correctly
after a rename.

Every action in your model gets an entry, whether or not the binding you pushed
can perform it. When that binding gives an action no executor, the entry
publishes without the executor fields, so the catalog records an action that
nothing is yet wired up to run. A push reads the binding named by `--profile`,
or by `default_profile` in `catalog.yaml` when you don't name one.

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
each action. The name, the description, the executor, the typed parameters,
`guards`, `affects`, and `ai_context.instructions` all survive the round trip
unchanged. [What push and pull preserve](fidelity.md) lists which parts of a
model survive that trip and which don't.

## 7. Run it

The sections so far declared an action, checked it and published it, and none
of that has put it in front of the database the write lands on. This section is
how you run one there, with arguments you choose, and see what comes back.
Pasting the statements into a SQL console would tell you the DML is valid; a
run is what exercises everything wrapped around it.

`kcmd action list` prints the actions your model declares, each with its
parameters, executor, guards and blast radius, plus the command line that
calls it where the profile binds an executor:

```bash
kcmd action list
```

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

`kcmd action run` performs one of those actions, against the database your
model's deployment target names under the selected profile.

### What a run does

`kcmd action run` resolves each entity-typed argument to a row, binds every
argument as a typed query parameter, then applies the action's statements in one
transaction:

```
  kcmd action run TransferFunds --arg source="Alice Checking" --arg amount=250
     │
     │ resolve   SELECT account_id FROM account
     │           WHERE name = @ref LIMIT 2
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

*Figure 3: the path of a run, from the argument the caller typed to the three
ways it can end.*

Nothing is interpolated into a statement. Every argument goes in as a query
parameter, and the argument's declared ontology type decides the store type that
parameter takes. Any failure before the commit rolls back, so no partial write
survives, and a refused commit wrote nothing either. The commonest refusal is
Spanner's `ABORTED` under lock contention, and the answer is to run the action
again.

The unknown outcome is a timeout or a 5xx, where your store may have applied
the write and lost the response. kcmd can't settle which, so it reports the run
as unknown rather than as a rollback; a caller who reads "nothing happened"
would retry a write your store had in fact applied.

Only a `sql` executor runs. An `mcp`, `rest` or `grpc` executor names an
operation in another system, which kcmd can't call and couldn't roll back if the
commit failed, so the call is refused rather than half-performed:

```
Error: Action 'TransferFunds' is executed by MCP, which runs outside this
transaction and could not be rolled back if the commit failed. Supply a handler
that performs the write as DML, or declare the action with a 'sql' executor.
```

### Which rows a call touches

Two things decide which rows a call touches, and they run at different moments:
kcmd resolves each entity-typed argument to one row before the write, and the
statement's own `WHERE` clause picks the rows the write lands on.

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

*Table 3: what each step takes, who runs it, and how many rows it may reach.*

**Resolving an argument.** An entity-typed parameter takes an object reference
rather than a value, so `--arg source="Alice Checking"` has to become one
specific row before anything can run. For each such parameter, kcmd runs one
lookup against that entity's table before the write. Given `--arg source=7`,
which could be a key or a name, the lookup asks for both:

```sql
SELECT account_id FROM account
WHERE account_id = @ref0 OR name = @ref LIMIT 2
```

That `WHERE` comes from two things your entity declares:

- **Its `primary_key`.** `Account` declares `primary_key: [accountId]`, and
  `accountId` is bound to the column `account_id`, so the input is compared
  against that column. Your model says which column the key is; nothing is
  inferred from the database. One argument can't name a key of several columns,
  so an entity keyed that way is reachable only through the identifying field
  below.
- **An identifying text field, if your entity has one.** That means a `String`
  field that isn't part of the key, bound to a plain column, and *named* `name`,
  `full_name`, `fullname`, `title`, `label` or `display_name`. Case doesn't
  matter, so `fullName` and `Title` count too. `Account` declares
  `name`, so `"Alice Checking"` and the account id both find the same row. The
  match is on the field's name in your model rather than the column's name in
  your store, and where an entity has more than one, the first it declares is
  used.

Each input is compared against a column as that column's own type. If the input
can't be a value of that type, kcmd drops the predicate rather than casting.
That is why figure 3 shows the shorter lookup for `"Alice Checking"`:
`accountId` is an `Integer`, no integer is spelled `Alice Checking`, and the key
predicate is left out. If nothing is left to compare, no query is sent at all.

One row has to come back, and one only. No match gives you `No Account matches
'Alice Checking'.` Two or more rows are ambiguous, so the candidates are listed
by key and you pick one. A name isn't required to be unique, so two accounts can
carry `Alice Checking`:

```
Error: 'Alice Checking' matches more than one Account (7, 12); use a key to
disambiguate.
```

kcmd lists them instead of guessing, so you can run the call again with a key.

**Targeting the write.** Resolution produces a *value*, and your statement uses
it. The statement's own `WHERE` clause decides how many rows it lands on, and
nothing would stop one that hits every dormant account. That is what
[section 3](#3-say-what-it-changes) means by `affects` declaring the blast
radius rather than limiting it.

### Why a guarded action is refused

Nothing in kcmd evaluates an expression against live data today, so `kcmd
action run` refuses a call that a non-advisory expression guards rather than
running the write unchecked. Quietly ignoring a rule your model declares would
be worse than no runtime at all, because anyone reading that model has every
reason to think the write was checked. The refusal names the rule:

```
Error: Action 'TransferFunds' is guarded by 'AmountIsPositive', and this runtime
does not evaluate constraints yet. Running it would apply a write the model says
must be checked first, so it is refused rather than run unchecked.
```

Only a constraint named in the action's `guards` can refuse a call like this,
which is [section 2](#2-gate-it-with-a-constraint)'s rule applied here. A
constraint your action doesn't name has no bearing on the call, and the runtime
never goes looking for one.

An advisory rule is one declaring `on_violation: warn`. It reports a violation
instead of rejecting one, so gating on it would permanently block every run of
a model that states advisory rules.

A refusal like this is settled before a session opens, so a refused action
leaves no transaction behind.

### A guard settled in words

A guard stated as a `judgment` needs something that can read a sentence, and
`--judge` supplies one: Gemini on Vertex AI, reached with the project and the
credentials kcmd already holds.

```bash
kcmd action run IssueCredit --arg order=12347 --arg amount=5 \
    --arg memo="customer asked for a credit" --judge
```

That call runs against the commerce model under `demo/semantic-model/agent`. It
is the [credit policy worked through earlier](#a-credit-policy-worked-through)
rebuilt around the half of it kcmd can settle today. A profile binds
`IssueCredit` to a `sql` executor, so kcmd performs the write itself, and all
four rules the action names in `guards` are judgments.

Leave the flag off and a judged guard stops the call, because you supplied
nothing to settle it:

```
Error: Action 'IssueCredit' is guarded by 'CreditMemoNamesAServiceFailure',
which is settled by judgment rather than by an expression, and this runtime was
given no judge to ask. Running it would apply a write the model says must be
checked first, so it is refused rather than run unchecked.
```

Add the flag and that rule's own sentence goes to the model together with the
attempted call. The verdict comes back with a reason, and what happens next is
whatever that rule's `on_violation` says. The demo declares `warn` on this one.
The outputs below come from setting the field to each of its three values in
turn, because one rule showing all three branches is easier to follow than
three rules showing one each. With `reject`, the call stops:

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

**The rule is settled before the transaction opens.** A model call takes
seconds, and holding write locks across one costs more than it buys, so the
order is: ask the judge, refuse with nothing touched, then open the transaction.
Two things follow. No judge sees the state that the write produces, so a rule
about that state has to be an expression. And a judge reads committed state, so
two calls racing each other can each be allowed against a total that neither
will leave behind — a rule that has to hold under concurrency is an expression
too.

**The judge gets the attempted call.** It receives the rule's text, the action's
name and description, and the arguments as the caller stated them —
`order=12347` rather than the `Order` row that value resolves to. That's the
whole of what it has, unless your run also passes `--judge-reads-store`.

**A verdict routes through `on_violation` the way any other breach does.** It's
the same field [section 2](#2-gate-it-with-a-constraint) describes. A rule
declaring `escalate` stops the call and adds one sentence: "The model marks this
rule 'escalate', so an approver may allow it; nothing here can." Nothing in kcmd
is an approver, and a refusal that left this out would read as the end of the
matter. A rule declaring `warn` lets the write through and reports the verdict:

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

**A rule that never reached a judge is reported as unchecked.** You supplied no
judge, or the model call failed. Either way the run learns nothing about the
rule, and `on_violation` routes that like any other breach. An advisory guard
lets the write through and warns, naming the rule and ending "was not checked:
this run was given no judge to ask". A guard declaring `reject` or `escalate`
stops the call. The warning is there because committing in silence would tell
you every rule passed when one was never put to anybody. Skipped expression
guards are reported the same way, one warning line each, because supplying a
judge settles no expression.

**An expression guard that refuses stops the call before any judge is asked.**
An expression declaring `reject` or `escalate` refuses the action and no model
is reached; one declaring `warn` stands down, so the run reaches the judge and
commits, with a warning line for the expression that nothing checked. The demo
names no expression in `guards` at all, because naming one would make
`IssueCredit` refuse every call rather than check it. It keeps all three of the
[credit policy](#a-credit-policy-worked-through)'s expression rules as declared
constraints, and names judged counterparts of two of them in `guards` instead.
That is why the model loads with the all-judged warning.

### A guard that reads a row

Some rules can't be settled from the call alone. *The credit must not exceed the
total of the order it is applied to* compares an argument against a number in
your database, and the caller is under no obligation to state it correctly.
`--judge-reads-store` sends the judge to read it.

Two things have to be in place. Pass `--judge` alongside `--judge-reads-store`,
which says what a judge may do but doesn't hire one. And your profile has to
bind the entities the rule talks about to tables, because that binding is the
whole of what the judge is told about your database. With nothing bound, the
run stops before it starts and says so.

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

A run carrying the flag says the judge may read, and prints every statement the
judge sends:

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

The judge composed that statement itself, from the rule's sentence and the
tables your profile binds. kcmd prints every one, because a read made on your
behalf is yours to check.

Here's the same order again, with a credit of $200 and a memo asserting the
order is worth $900:

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
for a different reason: the judge says it can't get the total.

**The judge sees what your model declares.** The entities, tables and columns in
its instructions come from your binding profile, so a column your model doesn't
bind is one the judge is never told exists. The dialect comes from there too:
the rule above produces GoogleSQL against `Orders.total` under a Spanner profile
and PostgreSQL against `purchase_order.order_total` under an AlloyDB one.

**Give the action's credentials no more reach than the tables your model
binds.** Every statement has to be a single command beginning with `SELECT` or
`WITH`, and it reaches your store wrapped as
`SELECT * FROM (...) AS judge_read LIMIT 21`, which the server refuses unless it
really is a query. That wrap stops a bare `UPDATE`, and two things get past it.
A query that calls a function that writes is still a query, and PostgreSQL
commits it, so a write can land that way on an AlloyDB store. Spanner's
read-only query path stops the same statement. And nothing holds a statement to
the tables your model binds. Your bindings tell the judge which tables exist
rather than confining it to them, so a read reaches whatever the credentials
behind the action reach.

**Keep the rule settleable from a few rows.** A judge gets four reads to settle
one guard. At most 20 rows come back from each, and each value is clipped at 200
characters. The judge is told when one of those caps applied, the read budget
included. A rule needing a scan, a join across the history, or a total of its
own belongs in an `expression`. A judge that still can't tell is instructed to
answer that the rule doesn't hold, and `on_violation` routes that like any other
breach.

**Reading costs model calls.** A guard with a store attached costs two calls
rather than one, even when it reads nothing, because asking and answering
can't be the same request. Each further round of reading adds one more. The
demo's four judged guards read once between them and cost nine calls.

The race described under
[a guard settled in words](#a-guard-settled-in-words) applies here too, and
reading doesn't change it: the judge reads committed state, before the
transaction opens.

## 8. Hand it to an agent

You don't write the tools an agent calls. You point an agent at your model, and
what it can read, what it can change and what gates the change are all derived
from it.

Every entity in your model turns into a **lookup tool** that reads it, and every
action turns into a **write tool** that runs it. Nothing else in the model
becomes a tool of its own.

The other parts either shape those tools or reach an agent not at all:

- A **constraint** reaches an agent only through an action that guards on it.
  One that can refuse the call is named in that tool's description; one nothing
  can settle leaves the tool uncallable.
- Your model's **`ai_context`** becomes the **instruction** handed over with
  the set.
- **Relationships** and **metrics** get no tool. A lookup reads one entity and
  can't join, so an agent walks a relationship by looking up each end itself,
  and nothing totals anything on its behalf.

`kcmd agent tools` prints the whole set. It reads your model and nothing else,
so it opens no session and changes nothing:

```bash
kcmd agent tools
```

For the model built up on this page, that set is:

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
      transferId: string
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
      you cannot approve it yourself. When a write did happen and the tool
      returns warnings, the change landed and a rule still went unmet or
      unchecked: report both, because nobody else will. Finish by saying what
      you changed.
```

Most of the listing traces back to a key in your model or your profile, one
line of output per key:

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

Two parts come from neither file. The step that turns a model into tools — the
**derivation**, which this command and the library behind it both run — appends
a paragraph to the instruction, its own text about using the tools, identical
for every model. The runtime adds `[NOT RUNNABLE]` and the paragraph under it,
which say whether this call could succeed.

Nothing in the listing was written for a particular agent. It reads the same
whether your caller is ADK, LangChain, or a person deciding whether the model
says enough yet.

### What a write tool and a lookup tool do

A **write tool** runs the action. Calling `transfer_funds` does the same
resolve, bind and transact as [`kcmd action run TransferFunds`](#7-run-it) —
the same argument resolution, the same single transaction, the same three
outcomes.

A **lookup tool** reads one entity: exact match on any bound field, combined
with AND, capped at 50 rows. It can't join, compare ranges, aggregate or order.
That's enough to turn `"Alice Checking"` into the account id your write tool
needs, and it keeps the generated SQL checkable by eye. Table and column names
come from your binding and every filter value is a bound parameter, so no caller
text reaches the SQL.

A lookup is named for its entity, and an action keeps its own name when the two
collide. An entity named `Account` and an action named `FindAccount` both derive
`find_account`. The action takes that name, because you wrote it, and the lookup
becomes `lookup_account`. Deriving the write tools and the lookups together is
what makes the collision visible at all.

### A tool says whether it can be called

`transfer_funds` above is listed and marked `[NOT RUNNABLE]`. `TransferFunds`
names a guard stated as an expression, nothing in kcmd evaluates one, and so the
[refusal from section 7](#why-a-guarded-action-is-refused) arrives here instead
— before any agent exists, rather than inside a transaction.

An action guarded by a judgment is marked the same way when the derivation holds
no judge, because the listing reports what the runtime would do with what it's
holding. Supply a judge and the same action is offerable, with the same
description and the same parameters:

```console
$ kcmd agent tools
...
  action  issue_credit  (IssueCredit)  [NOT RUNNABLE]

$ kcmd agent tools --judge
Rules stated in words go to gemini-2.5-flash (us-central1).
...
  action  issue_credit  (IssueCredit)
```

The flag takes an optional model name, the same way [`kcmd action run
--judge`](#a-guard-settled-in-words) does, and it calls no judge. A judge
settles a rule when an action runs, and printing what an agent is offered runs
no action, so this listing costs you nothing however many guarded actions it
names.

A tool this binding can't serve still comes back, still named and still
described — an action your model declares shouldn't vanish from the set your
model offers — so the listing prints what it's waiting on instead. Write tools
and lookups each carry a `runnable` flag, and `unavailable` carries the reason.

A **write tool** is withheld for one of four reasons:

- This binding supplies no executor, because the model declared none or a
  profile withdrew it with `executor: null`.
- The executor is `mcp`, `rest` or `grpc`, and the caller supplied no handler
  to perform the write.
- It names a guard this runtime cannot settle — an expression, or a judgment
  with no judge to ask.
- A parameter refers to an entity whose key has several parts, which the
  runtime can't bind to a statement as one value.

A **lookup** is withheld for reasons of its own:

- The entity is abstract, so it groups its subtypes and has no table to read.
- No field of it is bound to a plain column, so there is nothing to select.
- Its `source` is empty, or reads as a query rather than a table.

Either kind is withheld when the runtime has no store, because a call needs
somewhere to land. The derivation asks the runtime for every one of these
verdicts instead of working them out again, so the two can't drift: a tool
advertised as runnable that refuses each call spends your agent's turn, and one
withheld that would have worked is never tried.

### Calling it from code

`kcmd agent tools` prints these tools; `modelTools` returns them. Both take a
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

`modelTools` returns `{lookups, actions, instruction}` — the three things the
listing printed. `callableTools` then sorts the lookups and the actions into the
ones this binding can serve and the ones it can't, which is a split every
adapter has to make and the same split every time. Offer `callable` to your
agent, and report `withheld` instead of hiding it. `actionTools` and
`entityTools` are exported for a caller that wants one kind.

Each tool is a name, a description, typed parameters and `invoke(args)`, so
binding one to ADK, to LangChain or to an MCP server is a short adapter over
that shape, and a second framework costs you nothing here. Nothing in this
module imports an agent framework.

`invoke` answers with three states: the write landed, the write didn't happen,
or the statements ran and the commit gave no answer either way. That last one
comes back as `unknown` alongside an explicit instruction not to retry, because
a caller reading it as "nothing happened" applies the write twice. A write that
landed carries `committedAt` and `actedOn`, the rows each argument resolved to;
one that didn't carries `reason` and `whatToDo`. Only a write that landed
carries `warnings`, so dropping them tells your agent a write met every rule the
model states when it didn't.

`modelTools` also takes `judge`, and an action guarded by a judgment is callable
only when you pass one. `GeminiJudge` implements the seam over Vertex AI, and so
does anything carrying a name and a `decide` method. Omit it and such an action
is still derived, still named and still described, and reported in `withheld`.
The judge goes to the derivation rather than to each call because one object has
to answer `runnable` and answer the call: a tool derived with a judge and then
invoked without one would be advertised as callable and refused mid-call.

Pass `handler` for an executor this runtime can't perform itself. An action with
a `sql` executor never receives it. Such an action promises that the catalog
published the statements it runs, and one handler serves the whole model, so
handing it through would break that promise for every `sql` action at once.

One call to `createSemanticRuntimes` returns a runtime for every model document
in your entry group. Each runtime carries the store that its deployment target
names, the profile it was built under, and the document it was authored in, so a
message about one model can say which file and which profile produced it.

`runtime.store.kind` is `'spanner'`, `'alloydb'` or `'bigquery'`, and only a
Spanner or AlloyDB store takes a write. Ask a BigQuery-backed runtime for a
client and you get an error naming the dataset instead, because an action's
statements need an operational database. A model whose profile binds no store at
all still gets a runtime, with `storeError` saying why. Its tools are still
derived, each marked unavailable for that reason, so your agent is told what the
model offers and why it can't reach it.

Go through `createSemanticRuntimes` instead of building a client yourself. It
also checks that every entity is bound to a table in the store your profile
targets. Without it, a model could be bound to some other system, and a lookup
derived from that model would read whatever table of that name your target store
happens to hold.

### Who owns the instruction

The instruction at the foot of the listing has two parts, because two different
people own them.

One part is your model's own `ai_context.instructions` — what this business asks
of anything that acts on it, including the agents nobody has written yet. It
belongs to the model because an agent carrying the same rule in its own source
is a place someone can change that rule without the people who own the model
finding out. Agents get replaced when frameworks change; your model doesn't.

The other part is about the tools rather than the business: what a lookup is
for, and what a refused write means. The derivation owes that part, because it
describes a contract this module defines and your model never stated. Write it
into each agent instead and you copy the same paragraph into every adapter,
where it drifts in each one.

So an agent that appends a persona of its own is saying something your model did
not. Put it in the model.

### The commerce demo, worked through

`demo/semantic-model/agent/` is an agent built this way, running against a live
operational store: a commerce model, a binding profile, and an `agent.ts` of 72
code lines that names no table, no column, no business term and no dollar
threshold. Thirteen of those lines are the adapter onto the agent framework. Its
README walks the same steps and reaches all three of `on_violation`'s outcomes
against that store: a $30 credit held because the model's $25 self-service
ceiling is `escalate`, a credit written with a warning because the memo names no
service failure, and a credit refused outright because the memo admits it's one
piece of a larger amount.

None of those three outcomes was decided in `agent.ts`. The ceiling, the memo
rule and the split-credit rule came out of the model, and the runtime settled
each one on the way through the call. Point the same file at a different model
and profile and it runs a different business; the README lists the files that
change for that, and `agent.ts` isn't among them.

The README also states what that costs and what it can't do. The model guards on
four judgments and the judge it hires can query the store, so the demo loads
with the all-judged warning. It pays two model calls per guard, plus one for
each round of reading — nine calls in the run the README captures. Two of its
rules fall short of what they say:

- **An order's total matching its line items is declared and not enforced.**
  It's a statement about the state the write leaves behind, and guards settle
  before the write.
- **The split-credit rule catches only a disclosed split.** It fires because
  the model tells callers to disclose a split in the memo, which makes it a
  check on honest mistakes rather than a control. A version that held
  regardless would count the credits already on the order. A reading judge
  could do that; this model doesn't ask it to.

## What is not modeled yet

This is a prototype. Three things you might reasonably expect are absent.

- **Only a rule stated in words gets checked.** `kcmd action run --judge`
  settles a guard whose constraint carries a `judgment`. No component evaluates
  an expression against live data, and an action guarding on one is refused
  rather than run. That refusal is easy to spot, and it still leaves the rule
  unchecked. Whoever wrote a statement owns the correctness of what it does.
- **kcmd calls no executor but its own.** A `sql` action runs; an `mcp`, `rest`
  or `grpc` one is published for whoever dispatches it, which is why those three
  name coordinates instead of a statement.
- **The store is Spanner or AlloyDB.** `kcmd action run` resolves, binds and
  transacts against the database your profile's deployment target names, which
  may be either of those. A model bound to BigQuery publishes its actions and
  runs none of them.
