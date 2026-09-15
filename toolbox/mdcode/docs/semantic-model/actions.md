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
discovers your model discovers what it can change there, not just what it can
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

### A policy whose rules end differently

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

The five rules produce three different outcomes, and the two written as
judgments — the memo and the split credit — are the ones no query can settle.
The model behind them has an `Order` with a `total`, a `LineItem` with an
`amount` and a `memo`, and an `IssueCredit` action taking the order, the amount
and the memo. Each rule becomes one constraint carrying its own outcome in its
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

Each `on_violation` key carries one branch of what your policy describes in
prose, in a form a search can read.

**Rule 3 declares `reject`, because it's the one rule here nobody in the
business may approve.** An order whose total disagrees with its line items is
broken rather than merely unusual. That word takes effect only once
`IssueCredit` names the rule in `guards`.

Naming it makes `IssueCredit` refuse to run against an order whose books already
disagree. It won't catch a credit that *breaks* that agreement, because that
means checking the state the write produces, and your model can't bind such a
check yet. A guard therefore enforces rule 3 more narrowly than the rule reads.

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

### Two calls through that policy

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

When one call violates several guards, the strictest outcome applies. Any
`reject` refuses the call; failing that, any `escalate` holds it; failing that,
any `warn` lets it through with the violations reported.

That combination is fixed, and no part of your model states it, so your action
can name any number of guards without you writing down how to combine them. The
same precedence is how `forbid` overrides `permit` in Cedar and how a deny wins
in Open Policy Agent, so a policy written this way lowers into either.

An action whose guards are *all* judged loads with a warning. Every gate then
costs a model call, none can lower to a store-level check, and each may decide
two identical calls differently. `IssueCredit` stays clear of that: three of its
five guards are expressions.

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
stays unknown until you declare it here:

```yaml
        affects: [Account, Transfer]
```

That's the coarse form: these concepts are touched, in a way your model doesn't
spell out. It's enough to answer *which actions can change an account at all*,
which is already more than an executor name answers.

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

Be precise about the concepts you've worked out and coarse about the rest. The
two shapes sit in one list together, so a vague entry costs you nothing on the
ones you know. Every `concept` — bare, or named under the key — has to be
something the same model declares.

### One key for both kinds

`concept` takes an entity or a relationship, written the same way for either
kind — your model already records which one it is. `TransferDebits` above is
the edge from the example model, and it sits in the list exactly like the two
entities beside it.

### The operations

Use `create`, `modify` or `delete` — the same three whatever the concept is.

`modify` covers an edge too: a junction table backs a many-to-many relationship
and has fields of its own, so *modify the grade on an Enrollment* is as
ordinary a change as *modify an order's total*.

Add `fields` to narrow a `create` or a `modify` to the fields the call writes,
which makes *which actions can change `Account.balance`* answerable. A
`delete` takes the whole instance, so a field named beside one is rejected,
not ignored.

Name the concept now and refine it later. Writing `- concept: Account` on its
own says the same thing the bare `Account` does, and it's written back as the
bare form.

### A created row gets its key from kcmd

When an action **creates** a row, kcmd generates that row's primary key — a
UUID — and binds it as `@new<Concept>Key`. The caller never supplies it,
because an agent that picks its own primary keys can overwrite an existing row
by choosing one already taken. Declaring the creation in `affects` turns the
generation on:

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

**Status: that key generation is the only thing `affects` drives.** Where a
statement actually binds a generated key, kcmd checks your model first: a
concept keyed by several columns, or by a key field that isn't a `String`,
can't take a generated UUID, so kcmd refuses the call and withholds the write
tool. A statement that supplies its own key is never refused over a generated
one it doesn't use. Past that, kcmd parses `affects`, checks every concept
against your model, publishes it and reads it back. No component computes an
impact from it, routes on it, or checks it against what your executor does.

## 4. Check it before pushing

Run this before you push, so a typo costs you a second instead of a round
trip:

```bash
kcmd push --validate-only
```

Four things about any action can be statically wrong once your document parses,
and each one is a hard error:

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

A parameter type that resolves to neither an entity nor a scalar leaves your
model with nothing to say about what that argument denotes. An executor missing
a coordinate gives whatever picks the action up nothing to dispatch. A guard
can name a constraint your model never declares; `AmountIsPostive` here
misspells the `AmountIsPositive` declared above, so you believe the write is
checked while nothing checks it. An `affects` entry naming `Acount` claims a
blast radius over a concept that doesn't exist, so a consumer that reads it
learns nothing.

kcmd checks the rest of an `affects` entry just as strictly. Fields
beside a `delete` are a hard error, and so is a field the concept doesn't
declare. An operation outside `create` / `modify` / `delete` never gets this far
— the vocabulary is closed, so your document doesn't parse at all. These checks
are static, so they run on every push whatever the destination.

### What push holds a statement to

kcmd checks a `sql` executor further than the other three kinds, because it
carries the write rather than a pointer to whoever performs it:

- Write each statement as a **single `INSERT`, `UPDATE` or `DELETE`**. A
  statement that reads is a query and belongs in a metric; one that reshapes the
  schema isn't an action. A `;` anywhere but the end is rejected, because each
  list entry runs on its own and anything after the separator would silently not
  run.
- Pass every value as a **bound `@parameter`** naming a parameter your action
  declares, or the `@new<Concept>Key` a `create` in `affects` generates. Nothing
  is interpolated into the statement text, so an argument can't become SQL.
- Nothing else is available: no control flow, and no statement composed at call
  time. `statements` is a fixed list in your model, so an action whose body
  arrived with the call would declare nothing, and a gate can't check what was
  never declared.

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
that it won't deploy them.

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

An action with a `sql` executor is a write kcmd can perform for you. Two
commands:

```bash
kcmd action list
kcmd action run TransferFunds --arg source="Alice Checking" \
    --arg target=ACC-2 --arg amount=250
```

That second command doesn't succeed against the model built up on this page.
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
can run. Two separate things decide which rows your action touches:

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

That `WHERE` comes from two things your entity declares:

- **Its `primary_key`.** `Account` declares `primary_key: [accountId]`, and
  `accountId` is bound to the column `account_id`, so the input is compared
  against that column. This answers "how does it know which column is the key" —
  your model says so, and nothing is inferred from the database. One argument
  can't name a key of several columns, so an entity keyed that way is reachable
  only through the identifying field below.
- **An identifying text field, if your entity has one.** That means a `String`
  field that isn't part of the key, bound to a plain column, and *named* `name`,
  `full_name`, `fullname`, `title`, `label` or `display_name`, matched without
  regard to case, so `fullName` and `Title` count too. `Account` declares
  `name`, so `"Alice Checking"` and the account id both find the same row. The
  match is on the field's name in your model rather than the column's name in
  your store, and where an entity has more than one, the first it declares is
  used.

Each input is compared against a column as that column's own type, so a key
declared `Integer` is compared only when the input is a number. `"Alice
Checking"` isn't, so that predicate is dropped instead of cast. If nothing is
left to compare, no query is sent at all.

One row has to come back, and one only. No match gives you `No Account matches
'Alice Checking'.` Two or more rows are ambiguous, so the candidates are listed
by key and you pick one. A name isn't required to be unique, so two accounts can
carry `Alice Checking`:

```
Error: 'Alice Checking' matches more than one Account (7, 12); use a key to
disambiguate.
```

kcmd reports both instead of guessing, because both are things you can act on.

**Targeting the write.** Resolution produces a *value*, and your statement uses
it. The statement's own `WHERE` clause decides how many rows it lands on, and
nothing would stop one that hits every dormant account. `affects` declares the
blast radius rather than limiting it, so that a reader knows what the write is
about and an evaluator can one day check the statements against what you
declared.

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

Nothing is interpolated into a statement. Every argument goes in as a query
parameter, and the argument's declared ontology type decides the store type that
parameter takes. Any failure before the commit rolls back, so no partial write
survives, and a commit your store *refuses* wrote nothing either. The commonest
refusal is Spanner's `ABORTED` under lock contention, and the answer to it is to
run the action again.

The third outcome is a timeout or a 5xx, where your store may have applied the
write and lost the response. kcmd can't settle which, so it reports the run as
unknown rather than as a rollback; a caller who reads "nothing happened" would
retry a write your store had in fact applied.

The write goes to your model's deployment target under the selected profile —
the Spanner or AlloyDB database that target names. The command line never names
a database. Use `--profile` to change the store, and [push](profiles.md)
follows the same rule.

Only a `sql` executor runs. An `mcp`, `rest` or `grpc` executor names an
operation in another system, which kcmd can't call and couldn't roll back if the
commit failed, so the call is refused rather than half-performed:

```
Error: Action 'TransferFunds' is executed by MCP, which runs outside this
transaction and could not be rolled back if the commit failed. Supply a handler
that performs the write as DML, or declare the action with a 'sql' executor.
```

### Why a guarded action is refused

No component here evaluates an expression against live data, so `kcmd action
run` refuses a call that an expression guards rather than running the write
unchecked. Quietly ignoring a rule your model declares would be worse than no
runtime at all, because your model states that the write is checked and nothing
says otherwise. The refusal names the rule:

```
Error: Action 'TransferFunds' is guarded by 'AmountIsPositive', and this runtime
does not evaluate constraints yet. Running it would apply a write the model says
must be checked first, so it is refused rather than run unchecked.
```

Only a constraint named in the action's `guards` can refuse a call like this,
which is [section 2](#2-gate-it-with-a-constraint)'s rule applied here. A
constraint your action doesn't name has no bearing on the call, and the runtime
never goes looking for one.

The exception is a constraint declaring `onViolation: warn`. An advisory rule
reports a violation instead of rejecting one, so gating on it would permanently
block every run of a model that states advisory rules.

Every refusal is decided before a session opens, so a refused action leaves no
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

**`on_violation` decides what a verdict does.** It's the same field
[section 2](#2-gate-it-with-a-constraint) describes, and a judge's verdict
routes through it the way any other breach does. A rule declaring `escalate`
stops the call and adds one sentence: "The model marks this rule 'escalate', so
an approver may allow it; nothing here can." Nothing in kcmd is an approver, and
a refusal that left this out would read as the end of the matter. A rule
declaring `warn` lets the write through and reports the verdict:

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

**A rule nobody could ask about is reported as unchecked.** You supplied no
judge, or the model call failed. Either way the run learns nothing about the
rule, and `on_violation` routes that like any other breach. An advisory guard
lets the write through and warns, naming the rule and ending "was not checked:
this run was given no judge to ask". A guard declaring `reject` or `escalate`
stops the call. The warning is there because committing in silence would tell
you every rule passed when one was never put to anybody. Expression guards the
run skipped are reported the same way, one warning line each, because supplying
a judge settles no expression.

**Status: an expression guard that refuses stops the call before any judge is
asked.** An expression declaring `reject` or `escalate` refuses the action above
and no model is reached; one declaring `warn` stands down, and the run reaches
the judge and commits, with a warning line for the expression nothing checked.
Three of the five guards
[section 2](#a-policy-whose-rules-end-differently) puts on `IssueCredit` are
expressions declaring `escalate` or `reject`, so the runs here guard on the
judged rule alone — which is also why they load with the all-judged warning.

### A guard that reads a row

Some rules can't be settled from the call alone. *The credit must not exceed the
total of the order it is applied to* compares an argument against a number in
your database, and the caller is under no obligation to state it correctly.
`--judge-reads-store` sends the judge to read it.

Two things have to be in place. Pass `--judge` alongside
`--judge-reads-store`, which says what a judge may do but doesn't hire one. And
your profile has to bind the entities the rule talks about to tables, because
that binding is the whole of what the judge is told about your database. With
nothing bound, the run stops before it starts and says so.

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
for the opposite reason: the judge says it can't get the total.

**The judge sees what your model declares.** The entities, tables and columns in
its instructions come from your binding profile, so a column your model doesn't
bind is one the judge is never told exists. The dialect comes from there too:
the rule above produces GoogleSQL against `Orders.total` under a Spanner profile
and PostgreSQL against `purchase_order.order_total` under an AlloyDB one.

**A judge can't write.** Every statement has to be a single command beginning
with `SELECT` or `WITH`, and it reaches your store wrapped as
`SELECT * FROM (...) AS judge_read LIMIT 21`, which the server refuses unless it
really is a query. Two things get past that wrap. First, a query calling a
function that writes is still a query, and PostgreSQL commits what it wraps
implicitly, so a write can land that way on an AlloyDB store where Spanner's
read-only query path stops it. Second, no check holds a statement to the tables
your model binds. Your bindings tell the judge which tables exist rather than
confining it to them, so a read reaches whatever the credentials behind the
action reach. Keep those credentials no wider than the tables your model binds.

**Keep the rule settleable from a few rows.** A judge gets four reads to settle
one guard. At most 20 rows come back from each, and each value is clipped at 200
characters. The judge is told when any of those caps bit, the read budget
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

An agent needs two things from your model: a way to find what's there, and a
way to change it. Your entities supply the first and your actions supply the
second, so both halves come out of the model you already have. One command
prints what an agent would be handed:

```bash
kcmd agent tools
```

Run it against the model built up on this page and it prints the listing below.
It only reads your model. It opens no session, calls nothing, and changes
nothing.

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

That's three things — one **write tool** for the action, one **lookup tool** for
each entity, and one **instruction** for whatever agent holds them. Every line
of it comes from a key in one of your two files, and each key produces one
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

Two parts of the listing come from neither file. The runtime adds
`[NOT RUNNABLE]` and the paragraph under it to say whether this call could
succeed. The derivation adds the second paragraph of the instruction, its own
text about using the tools, identical for every model.

Nothing in the listing was written for a particular agent. It reads the same
whether your caller is ADK, LangChain, or a person deciding whether the model
says enough yet.

### What the two kinds of tool do

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
becomes `lookup_account`. The collision is visible only because both halves get
derived together.

### A tool says whether it can be called

`transfer_funds` above is listed and marked `[NOT RUNNABLE]`. `TransferFunds`
names a guard stated as an expression, nothing here evaluates one, and so the
[refusal from section 7](#why-a-guarded-action-is-refused) is reported here
instead — before any agent exists, instead of inside a transaction.

An action guarded by a judgment is marked the same way when the derivation holds
no judge. The listing reports what the runtime *would* do with what it's
holding, and with no judge it would refuse. Supply
one, and the same action is offerable, with the same description and the same
parameters:

```console
$ kcmd agent tools --judge
Rules stated in words go to gemini-2.5-flash (us-central1).
...
  action  issue_credit  (IssueCredit)
```

The flag takes an optional model name, the same way [`kcmd action run
--judge`](#a-guard-settled-in-words) does. The flag doesn't call a judge. A
judge settles a rule when an action runs, and printing what an agent is offered
runs no action, so this listing costs you nothing however many guarded actions
it names.

The judge belongs to the derivation rather than to each invocation. Whether a
guarded action can be offered *at all* depends on holding a judge, so the same
object has to answer `runnable` and answer the call. A tool derived with a judge
and then invoked without one would be advertised as callable and refused
mid-call.

The tool still comes back, still named and still described. An action your model
declares shouldn't vanish from the set your model offers, so the listing prints
what that action is waiting on instead. Both halves carry a `runnable` flag,
and `unavailable` carries the reason.

A write tool is withheld when a profile withdrew the executor, when the
executor is remote and no handler was supplied, when it names a guard as above,
when a parameter references an entity keyed by several columns, or when the
statements ask for a generated key a UUID cannot fill. A lookup is withheld for
reasons of its own: the entity is abstract, so it has no table; no profile
bound it to a table; or its binding is a query rather than a table.

The derivation asks the runtime for that verdict instead of working it out
again, so the two can't drift. A tool advertised as runnable that refuses every
call spends your agent's turn and teaches it nothing. A tool withheld that would
have worked is never discovered at all.

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

`modelTools` also takes `judge`, and an action guarded by a judgment is callable
only when you pass one. `GeminiJudge` implements the seam over Vertex AI;
anything with a `decide` method does. Omit it and such an action is still
derived, still named and still described, and reported in `withheld`.

One call returns a runtime for every model document in your entry group. Each
runtime carries the store that its deployment target names, the profile it was
built under, and the document it was authored in, so a message about one model
can say which file and which profile produced it.

`runtime.store.kind` is `'spanner'`, `'alloydb'` or `'bigquery'`, and only the
first two accept a write. Ask a BigQuery-backed runtime for a client and you get
an error naming the dataset instead, because an action's statements need an
operational database. A model whose profile binds no store at all still gets a
runtime, with `storeError` saying why. Its tools are still derived, each marked
unavailable for that reason, so your agent is told what the model offers and why
it can't reach it.

Go through `createSemanticRuntimes` instead of building a client yourself. It
also checks that every entity is bound to a table in the store your profile
targets. Without it, a model could be bound to some other system, and a lookup
derived from that model would read whatever table of that name your target
store happens to hold.

`modelTools` returns `{lookups, actions, instruction}` — the three things the
listing printed. `callableTools` then sorts both halves into the ones this
binding can serve and the ones it can't, which is a split every adapter has to
make and the same split every time. Offer `callable` to your agent, and report
`withheld` instead of hiding it. `actionTools` and `entityTools` are exported
for a caller that wants one half.

Each tool is a name, a description, typed parameters and `invoke(args)`, so
binding one to ADK, to LangChain or to an MCP server is a short adapter over
that shape, and a second framework costs you nothing here. Nothing in this
module imports an agent framework.

`invoke` answers with three states. A write that landed and a write that didn't
are the obvious two. The third is a commit whose result nothing can establish,
reported as unknown with an explicit "do not retry", because a caller reading it
as "nothing happened" applies the write twice.

Pass `handler` for an executor this runtime can't perform itself. An action
with a `sql` executor never receives it. Such an action promises that the
catalog published the statements it runs, and one handler serves the whole
model, so handing it through would break that promise for every `sql` action
at once.

### The instruction is not the agent's to write

The instruction at the foot of the listing has two parts, because two different
people own them.

One part is your model's own `ai_context.instructions` — what this business asks
of anything that acts on it, including the agents nobody has written yet. It
belongs to the model because an agent can keep the same rule in its own source,
where someone can change it without the people who own the model finding out.
Agents get replaced when frameworks change; your model doesn't.

The other part is about the tools rather than the business: what a lookup is
for, and what a refused write means. The derivation owes that half, because it
describes a contract this module defines and your model never stated. Write it
into each agent instead and you copy the same paragraph into every adapter,
where it drifts in each one.

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
failure, and a credit refused outright because the memo admits it's one piece of
a larger amount.

It also states what that costs and what it can't do. The model guards on four
judgments and the judge it hires can query the store, so the demo loads with
the all-judged warning. It pays two model calls per guard, plus one for each
round of reading — nine calls in the run its README captures. Two of its rules
fall short of what they say:

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
