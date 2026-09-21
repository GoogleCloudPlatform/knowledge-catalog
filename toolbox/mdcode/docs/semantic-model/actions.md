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
and the executor. Whatever runs the action combines the two into one bound
model.

```mermaid
graph LR
    M["the model<br>concepts, actions, constraints"]
    P["a binding profile<br>tables, columns, executor, target"]
    RT(["one model, bound<br>ready to run"])
    ST["the store<br>where a write lands"]
    AG["what an agent is handed<br>write tools, instruction"]

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

The commands here are `kcmd`, which reads a model, pushes it, and derives the
tools an agent is handed under a binding profile. What the model states holds
for any runtime that reads it, and the library `kcmd` is built on is the same
one a service would embed.

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
          - name: source
            field: Account.accountId          # takes Account.accountId's type
            description: The account the money leaves.
          - name: target
            concept: Account                  # the same projection, written in two keys
            field: accountId
            description: The account the money goes to.
          - name: amount
            type: Float                       # no field carries this one
            description: How much money to move.
        ai_context:
          instructions: >-
            Resolve both accounts before calling.
    ai_context:                             # model level: true of every caller
      instructions: >-
        Never move money between two accounts held by the same customer
        without saying so in your answer.
```

You author the rest of the model — the deployment target, the entity bindings,
the relationships — the way you would for any model. See
[Deploying a semantic model](README.md).

Both `description` and `ai_context.instructions` travel through to the catalog,
and a parameter's `description` is what tells a caller which argument is which.
Two parameters a caller could confuse must each carry one, or the push fails.
Write the instructions for the agent that's going to call the action, the way
the example does.

### Projecting a parameter from a field

Every parameter carries one scalar value — the same kind of value a column
holds. What differs is where its definition comes from, and there are two ways
to give it one: **project** it from a field of your ontology, or **declare** it
on the spot.

#### A projected parameter takes its definition from a field

**A projected parameter** names a `concept` and a `field`, and takes that
field's datatype, description, label and AI context straight out of the model.
`source` above is an `Integer` because `Account.accountId` is one, so a caller
passes an account id and the write binds it as an integer. Change the field
later and every parameter projected from it follows, because there's no second
copy to keep in step. A `concept` is read the way `affects` reads one, so it can
name a relationship as well as an entity — but what you project from in practice
is an entity, because a relationship only has fields of its own when a junction
table backs it, and this format has no syntax for one yet.

The pair can be written two ways, and they load to the same parameter:

```yaml
          - { concept: Account, field: accountId }
          - { field: Account.accountId }
```

The one-key form spells the projection the way a metric expression or a
constraint judgment already spells a field, and is there for the same reason.
A `field` that carries a dot is read as `Concept.field`, so a `field` with more
than two parts is refused at load rather than read as half a reference, and so
is a dotted `field` beside a `concept`, which would name the concept twice —
that one is refused with both of the forms above spelled out for you.

Most projected parameters need no name of their own. Leave `name` out and the
parameter answers to the field's, so this one is called `accountId`:

```yaml
          - { concept: Account, field: accountId }
```

Name it yourself when one action takes the same field twice, the way
`TransferFunds` takes both a `source` and a `target`.

This shape holds however an entity is keyed. An `Account` identified by three
columns takes three projected parameters, one per key field, each typed from
the field it names — the same declaration a single-column key writes, three
times.

#### A declared parameter carries its own type

**A declared parameter** carries a value no field holds: the `amount` above, a
free-text memo, a reason code your store never keeps. Give it a `type` and a
description of your own. `type` takes a scalar datatype only, and naming an
entity there is an error telling you to project the field you meant. `datatype`
is accepted as a spelling of the same key — the one `fields:` already uses —
and stating both at once is refused rather than guessed at.

A projected parameter can't restate its field's `type`. If the type is wrong,
fix the field. If a statement needs a different one, cast it in the DML, where
the conversion is visible to whoever reads the write instead of buried in
metadata.

#### What else a parameter may carry

Each parameter may also carry:

- **`description`** — what the parameter means for this call. A projected
  parameter inherits the field's, and overriding it is how `source` and
  `target` above say different things while projecting one field. Required when
  two parameters on the same action project the same field or share a declared
  type, because neither can tell an agent which argument is which on its own —
  and the inherited wording does not count, since two parameters carrying one
  field's description verbatim are as indistinguishable as two carrying none.
- **`label`** and **`ai_context`** — inherited the same way, overridden the
  same way.
- **`default`** — a fallback value substituted when the caller omits the
  argument. Giving a parameter a default makes it optional; setting
  `required: true` alongside `default` is rejected.
- **`required: false`** — marks a parameter optional with no fallback; an
  omitted call binds `NULL` in SQL.

`default` and `required` are always yours to set, projected or not. A field
says what a value *is*; the parameter says how this one call uses it. A
parameter that states neither is required, so the two keys above are the only
ways to make one optional.

### Where the executor comes from

The executor tells a consumer where the operation lives. Pick one of these four
kinds, and give any one executor a single kind only:

- **`mcp`** — `{server, tool}`. A tool you've already registered in Agent
  Registry, named by the server's resource name and the tool's name within it.
- **`rest`** — `{endpoint, method}`. An HTTP endpoint and the verb to call it
  with.
- **`grpc`** — `{service, method}`. A service and the method on it.
- **`sql`** — `{statements}`. The write itself, carried in your model instead
  of named as a pointer to whoever performs it, and the only kind that needs an
  operational store to run against.
  See [carrying the write as DML](#carrying-the-write-as-dml).

Everything else your action declares is logical: what it takes, what gates it,
what it changes. None of that changes when you deploy the same model somewhere
else. The executor does, which is why it sits on the physical side with an
entity's `source`, and why a [binding profile](profiles.md) can supply one or
replace the one your model declares — for any of the four kinds. An action a
profile says nothing about keeps the executor the model gave it.

It changes for two different reasons. An `mcp`, `rest` or `grpc` executor is an
address: the operation lives at a different server, endpoint or service in
staging than it does in production, and where your rows sit never enters it. A
`sql` executor is the statement, written in the bound store's table and column
names and in its dialect, so until you know which store answers there's nothing
to write down. Only that last case turns on where the data lives.

### Actions declared but not performable

An action with no executor anywhere — none in the model, none in any profile —
is **declared but not performable**. It still says what it does, what it takes,
what gates it and what it changes; the only thing missing is who carries the
write out. Write one when nobody has wired the write up yet, or when another
team owns it and your model needs only to record that it exists.

Nothing declares this state: it follows from the executor being absent, so the
same action is performable under a profile that supplies one and not
performable under a profile that supplies none or withdraws the model's with
`executor: null`. A catalog-only push — `--no-profile`,
or a model with no deployment target — publishes it like any other action, and
`kcmd profiles` lists it under `cannot run:` for each binding that supplies no
executor for it.

## Carrying the write as DML

The first three kinds name a system that performs the write, which leaves the
write itself opaque to your model: an `mcp` tool name says where the operation
lives and nothing about what it touches. A `sql` executor carries the write
instead, so what your action does becomes readable — and checkable — from the
bound model, and an agent or tool framework can
[run it directly against your store](#7-hand-it-to-an-agent-kcmd-skills-generate)
rather than handing the write to another system to perform.

Statements are written in one database's own table and column names, in its own
dialect, so a `sql` executor goes in that database's [binding
profile](profiles.md) — beside the bindings for those same tables and columns —
rather than in the model it binds. Here it replaces the `mcp` executor the model
declared for `TransferFunds`:

```yaml
# payments.profiles/operational.yaml — this store owns the rows, so it writes them
semantic_model:
  - name: payments
    deployment_target: //spanner.googleapis.com/projects/my-project/instances/my-instance/databases/bank/propertyGraphs/payments
    entities:
      - name: Account
        source: //spanner.googleapis.com/projects/my-project/instances/my-instance/databases/bank/tables/account
        fields:
          - { name: accountId, expression: account_id }
          - { name: balance,   expression: balance }
          # ... and the model's remaining entities and fields, bound the same way
    actions:
      - name: TransferFunds
        executor:
          sql:
            statements:
              - UPDATE account SET balance = balance - @amount WHERE account_id = @source
              - UPDATE account SET balance = balance + @amount WHERE account_id = @target
              - INSERT INTO transfer (transfer_id, amount, debited_account_id) VALUES (GENERATE_UUID(), @amount, @source)
```

Selecting a profile replaces the model's bindings with that profile's, so the
one you put a `sql` executor in has to carry the columns its statements name as
well — leave them out and the fields come back unbound and the action cannot
run. Of the action itself, only the executor is restated: what the call takes,
what gates it and what it changes stay in the model, exactly as
[declared](#1-declare-the-action).

`statements` is a list because one business action is often more than one write.
The transfer above debits one account, credits another, and records the
transfer row itself, and a transfer that did only the first would lose money.
Running the statements in the order you wrote them inside one transaction
commits them together at the end, so writes that only make sense together never
apply by halves.

Carrying the write buys you two things:

- **Your blast radius is checkable.** A reader can compare `affects` against the
  statements instead of taking it on trust.
- **A guard becomes a real gate.** An MCP, REST or gRPC call commits inside a
  system your caller doesn't control, so a write it performed can't be rolled
  back if the rest of the action fails. Because a `sql` action declares its
  statements up front, the agent or tool framework running it can settle its
  guards before opening a transaction, so a refusal leaves the store untouched.

### Statements use your database names

**An action's statements reach your store exactly as you wrote them**, so every
table and column in one has to be the name your database uses. In the `sql`
executor above, the model's `Account` and `accountId` appear as `account` and
`account_id`. Those are the table and the column that the entity's `source` key
and its fields' `expression` keys bind it to.

`@parameter` references are the exception: they name an argument bound at call
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

The placement is enforced: select a profile whose model declares a `sql`
executor and the command refuses, naming the action:

```
Error: [payments] profile 'operational': action 'TransferFunds' in model
'payments' declares a 'sql' executor. A statement names one database's own
tables and columns, so it belongs in the profile that binds them, not in the
model. Move the executor into each profile that performs this write as DML.
```

A single-file model is the exception: that one document is both the model and
its binding, so its statements already sit beside the columns they name. Add a
profile beside it later and they move into the profile.

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
      judgment: …             guards: [X]        arguments bound    warn

  a rule in the           the only thing that    a language model   on_violation
  catalog, inert          gives it effect        reads the call     names one of
                                                 and settles it     the three
```

*Figure 2: a constraint moves from declared, to referenced by an action, to
checked before a call, to a breach routed by `on_violation`.*

A constraint has one body, `judgment`: the rule written as a sentence, settled
by a language model reading the attempted call.

### Naming a constraint as a guard

An action's `guards` list is what puts a constraint to work. Declare the rule,
then name it on the action — one line on the `TransferFunds` from section 1:

```yaml
    constraints:
      - name: TransferWithinAvailableBalance
        judgment: >-
          The amount argument of this call must not exceed Account.balance on
          the source account. That balance is on record rather than stated in
          the arguments, and nothing puts it in front of you.
        on_violation: reject
        description: >-
          A transfer cannot move more than the source account holds. Lower the
          amount, or choose another account.
    actions:
      - name: TransferFunds
        guards: [TransferWithinAvailableBalance]
```

`guards` holds the names of constraints your model declares, and listing one
there is what makes it apply to that action. Put the reference on the action
rather than on the constraint, because the same rule may gate `TransferFunds`
and leave `CloseAccount` alone.

That rule is the honest shape of a balance check and it is also one nothing here
enforces: the balance is a row, a judge is shown the arguments and no more, and
a rule it cannot settle it reports as not holding — which under `reject` refuses
every call. Declared this way it is a policy on record and a schema constraint
waiting to be written, not a control. Keep reading with that in mind; [what a
guard can see](#what-a-guard-can-see) explains why.

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

A guard that names no constraint fails the push, so a typo can't leave you
believing a write is checked when nothing checks it. The reverse isn't an
error: a constraint no action names is declared, published and inert, which is
a reasonable thing to publish for a reader or for an action you haven't written
yet.

### What a judgment costs

A judgment is a whole constraint body. Here is one, with the two fields that
say what a breach does and how grave it is:

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

Settling that rule is a model call, and one goes out for every guard on every
attempted write. The verdict can also move: a ceiling of 25 dollars, stated as a
judgment, can answer two identical calls differently, where `amount <= 25` could
not.

So write a judgment for a rule that has to weigh what a caller wrote, where
nothing shorter would settle it. Two cases are worth keeping out. A threshold
over the call's own arguments is the first: `amount <= 25` needs no reading at
all, and a sentence buys you a model call and a verdict that can move.
Leave it in whatever dispatches the call — the model has no home for it today,
which is in [what is not modeled yet](#what-is-not-modeled-yet).

A rule that turns on a stored value is the second. Nothing fetches that value
for the judge, so the sentence gets settled against a figure the model supplied
itself or refused for want of one. Write the rule down anyway if the model is
where your policy lives, and enforce it in your schema — see
[what a guard can see](#what-a-guard-can-see).

Every constraint must state `on_violation`, and any of the three words will do.
Omit it and the push fails, because an unmarked constraint would reject, and
that's too strong a consequence to inherit by silence.

### What a guard can see

A guard is checked before the call, with the arguments bound and before any
transaction opens. It sees one thing: the arguments it was handed. A rule about
the arguments — whether the memo the caller wrote names a real service failure,
say — is settled completely, because the arguments are the whole of what it
reads.

Nothing settles a rule about a stored value the call doesn't carry. A judge is
given the rule, the action and the arguments, and goes nowhere for anything
else, so *the credit must not exceed the total of the order* has no total to
compare against. The judge is instructed to treat a rule it cannot settle from
the arguments as one that does not hold and to say in its reason what was
missing — a safe failure, not a working check. Put that rule in your schema,
where the store enforces it inside the transaction.

Nothing settles a rule about the state a write *leaves behind*, either. "An
order's total equals the sum of its lines" has nothing to look at when the guard
runs, for a second reason: the state it describes does not exist yet. That one
belongs in the same place.

**Status: `judgment` is the only body a constraint has.** Whatever checks a
guard puts the sentence to a language model and routes the verdict by
`on_violation`.

### Writing a judgment

A language model reads your sentence at review time with the proposed write in
front of it. That reader is the judge. Five habits make that reading
consistent:

1. **State what must be true of the data.** Write the condition — *the memo
   must name a specific service failure*, and not the procedure, *check whether
   the memo is specific*. Your sentence describes a clean write, and everything
   about handling a breach lives elsewhere.
2. **Name fields model-qualified.** Write `LineItem.memo` rather than "the
   memo". A push resolves every `Entity.field` token in the text against your
   model and fails when the entity declares no such field, so a rename can't
   leave your sentence pointing at nothing. It also tells a reader which value
   the rule is about, which the judge cannot go and fetch.
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
settle: phrase the condition around the arguments the call carries, and put any
rule that depends on a stored row into your schema.

## A credit policy, worked through

Real policies have several rules, and the rules rarely end the same way. A
support agent is about to issue a customer-service credit, and five separate
rules bear on whether they may:

```
  the business rule                        a breach   settled
  ──────────────────────────────────────   ────────   ────────────────────────
  1  no credit above the order's total     escalate   judgment (policy; schema enforces)
  3  the memo names a service failure      warn       judgment
  4  not one credit split to evade review  reject     judgment
  ──────────────────────────────────────   ────────   ────────────────────────
  2  over 25 dollars needs a supervisor    —          your dispatch, not here
  5  the total equals the line items       —          your schema, not here
```

*Table 1: the three rules of the credit policy that a guard can carry, what a
breach of each one does, and the two rules that belong somewhere else.*

Rules 2 and 5 are in the table to be ruled out. Rule 5 is about the state a
write leaves behind, and a guard runs before the transaction opens, so no
constraint you write here reaches it; put it in your schema. Rule 2 compares one
argument against a literal: written as a judgment it would buy a model call to
perform a subtraction, and a verdict that can move at the boundary. Leave it in
whatever dispatches the call. The 25-dollar ceiling still governs the desk, and
rule 4 is written against it, but nothing in the model states it.

Writing the other three down needs an `Order` with a `total`, a `LineItem` with
an `amount` and a `memo`, and an `IssueCredit` action taking the order, the
amount and the memo. Each rule becomes one constraint, and each states its own
outcome in `on_violation`:

```yaml
    constraints:
      - name: CreditWithinOrderTotal              # rule 1
        judgment: >-
          The amount argument of this call must not exceed the total of the
          Order it is applied to. That total is on record rather than stated in
          the arguments, and nothing puts it in front of you. Read both as
          dollars.
        description: >-
          A credit cannot exceed the total of the order it credits. Lower the
          amount, or split it across the orders it actually covers.
        on_violation: escalate
        severity: high

      - name: CreditMemoNamesAServiceFailure      # rule 3
        judgment: >-
          LineItem.memo must name a specific, verifiable service failure on the
          order: a late delivery, a damaged item, a shipping charge applied in
          error. A memo that states only that the customer requested a credit
          does not satisfy this rule.
        description: >-
          Say what went wrong with the order in the credit memo.
        on_violation: warn
        severity: low

      - name: CreditIsNotSplitToAvoidReview       # rule 4
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
          - { name: order,  concept: Order, field: orderId }
          - { name: amount, type: Decimal }
          - { name: memo,   type: String }
        guards:
          - CreditWithinOrderTotal
          - CreditMemoNamesAServiceFailure
          - CreditIsNotSplitToAvoidReview
```

Each `on_violation` key carries one branch of what your policy describes in
prose, in a form a search can read.

**Rules 3 and 4 are the reason a constraint is written in words.** Neither
reduces to arithmetic over `Order` and `LineItem` at all, so there's nowhere
else to put them but a policy document nothing links to.

**Rule 1 is arithmetic against a row, and nothing here settles it.** It compares
the amount argument against a number that lives in the database, and a judge
sees the arguments only, so the rule is recorded in the model and enforced in
your schema — see
[what a guard can see](#what-a-guard-can-see). Rule 2 is the
same comparison against a literal rather than a row, and that difference is the
whole reason it stays out of the model. Rule 4 reads on the credits already
sitting on the order, so it is the same case as rule 1.

**Rule 4 is a judgment that declares `reject`.** Splitting a credit to evade
review is a rule the business means as unappealable, and the pairing carries a
real cost, because a model can decide two identical credits differently and
`reject` leaves nobody to appeal to. The model publishes such a rule instead of
forbidding it, and makes it findable: an auditor asking which unappealable rules
your model settles gets an answer from one query over the constraints.

### Two calls through the policy

Here are two calls against order 12345, which totals $165.85. One is a
200-dollar credit for a shipping charge billed in error, which is more than the
order was ever worth. The other is three 9-dollar credits raised within the
hour, each memo reading some version of "customer asked":

```
                                  amount=200.00,         amount=9.00 x3,
                                  "shipping charge       "customer asked"
                                   applied in error"
  ──────────────────────────────  ─────────────────────  ─────────────────────
  1  within the order's total     violated ─▶ escalate   holds
  3  memo names a failure         holds                  violated ─▶ warn
  4  not split to evade review    holds                  violated ─▶ reject
  ──────────────────────────────  ─────────────────────  ─────────────────────
  strictest outcome wins          held for a supervisor  refused, with the
                                                         memo warning reported
```

*Table 2: how each of the two calls fares against the three rules, and the
outcome that wins.*

The supervisor who gets the first call reviews a credit against an order rather
than a SQL diff. The second call is the case rule 4 was written for. Every
per-call gate lets it through, because each 9-dollar credit sits under the
order's total on its own, and under the desk's 25-dollar ceiling too, and only
reading the three together as one 27-dollar credit puts them over it.

The bottom row of table 2 applies the strictest-outcome rule from section 2 —
an `escalate` with nothing stricter beside it holds the first call, and rule 4's
`reject` decides the second.

**Status: a run doesn't compute the strictest outcome.** The runtime puts the
guards to the judge in the order your model declares them and stops at the
first one that fails without being advisory. What comes back is that guard's
outcome rather than the strictest of them, and a `warn` collected on the way
there doesn't travel with the refusal.

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

Once your document parses, five checks run over every action, and a failure in
any of them stops the push:

- **Every parameter has a type the model can settle** — projected from a field,
  or a scalar datatype you named. A `concept` the model doesn't declare, a
  `field` that concept doesn't have, a `type` sitting on a projected parameter,
  and a `type` naming an entity are four different mistakes and report as four
  different errors.
- **Parameters a caller could confuse each carry a `description`.** Two
  parameters projecting `Account.accountId`, or two sharing a declared type,
  otherwise produce identical tool argument documentation, leaving an agent
  guessing which is `source` and which is `target`.
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

A model that breaks all five reports all five, one line each, and deploys
nothing:

```
Error: action 'TransferFunds' in model 'payments' (payments) has parameter
'amount' typed 'Currency', which is not a scalar datatype
(String/Integer/Decimal/Float/Boolean/Date/Time/DateTime/DateTimeTz/Opaque).
Error: action 'TransferFunds' in model 'payments' (payments) has multiple
parameters projected from 'Account.accountId', so parameters 'source' and
'target' must each have a 'description' of their own to distinguish them.
Error: action 'TransferFunds' in model 'payments' (payments) has an mcp
executor whose 'tool' is missing or blank.
Error: action 'TransferFunds' in model 'payments' (payments) is guarded by
'TransferWithinAvailableBalence', but model 'payments' declares no constraint
of that name.
Error: action 'TransferFunds' in model 'payments' (payments) affects 'Acount',
which is neither an entity nor a relationship this model declares.
```

`TransferWithinAvailableBalence` there misspells the
`TransferWithinAvailableBalance` the model declares, and `Acount` misspells
`Account` — the two typos a reader of the document would skim straight past.

kcmd checks the rest of an `affects` entry just as strictly. Fields beside a
`delete` are a hard error, and so is a field the concept doesn't declare. An
operation outside `create` / `modify` / `delete` never gets this far — the
vocabulary is closed, so your document doesn't parse at all.

The two checks that read your ontology stand down when a binding profile
resolves your model. Resolving drops entities and relationships the profile
can't bind, so holding `affects` to the ontology there would fail your deploy
over a concept the profile removed rather than one you mistyped. An undeclared
concept and an undeclared field fall back to the warning the loader already
gave. A catalog-only push reads the author's model whole, so it treats the same
two as hard errors. Fields beside a `delete` read only the entry, so that one
fails everywhere.

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
      - {name: source, type: Integer, concept: Account, field: accountId, description: The account the money leaves.}
      - {name: target, type: Integer, concept: Account, field: accountId, description: The account the money goes to.}
      - {name: amount, type: Float}
    affects:
      - {concept: Account, operation: modify, fields: [balance]}
      - {concept: Transfer, operation: create}
      - {concept: TransferDebits, operation: create}
    instructions: Resolve both accounts before calling.
```

A projected parameter publishes both halves: the `concept` and `field` it came
from, and the `type` that projection settled on. The reference is what you
wrote and what a pull reads back, so the link into your ontology survives the
round trip. The resolved type is there for a consumer reading the catalog
without your model in hand, which would otherwise have no way to know what to
pass.

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

## 7. Hand it to an agent (`kcmd skills-generate`)

You don't hand-write prompts or tool wrappers for each agent framework. Run
`kcmd skills-generate` against your model and binding profile, and `kcmd`
writes an [Agent Skill](https://agentskills.io) — a folder of Markdown files
that Claude Code, Gemini CLI, Cursor, and other skill-compatible agents load
directly:

```bash
kcmd skills-generate --out skills
```

```
Wrote skills/payments/SKILL.md
Wrote skills/payments/references/transfer-funds.md
```

The generated skill splits into two layers so an agent only loads the detail of
the action it actually needs:

1. **`SKILL.md` (the router)** — loaded when the skill triggers. It carries the
   model's description, a table of actions pointing to `references/*.md`, how
   the model wants to be used (`ai_context.instructions`), how to read keys
   from the bound store (`Finding a record`), and the deployment details for the
   selected profile (`Running an action`).
2. **`references/<action>.md` (one reference page per action)** — loaded on
   demand when the agent picks an action. For `TransferFunds`,
   `references/transfer-funds.md` carries:

```markdown
# TransferFunds

Action `TransferFunds` of the `payments` model. As a tool it is named `transfer_funds`.

Move money from one account to another.

## Arguments

| Name | Type | Required | What to pass |
| --- | --- | --- | --- |
| `source` | integer | yes | The account the money leaves. |
| `target` | integer | yes | The account the money goes to. |
| `amount` | number | yes | How much money to move. |

## How to call it

Resolve both accounts before calling.

## Rules that apply to this call

Each is settled before anything is written, from the attempted call and, where
the rule is about something on record, the record.

### TransferWithinAvailableBalance

On violation: `reject`

> The amount argument of this call must not exceed Account.balance on the source
> account. That balance is on record rather than stated in the arguments, and
> nothing puts it in front of you.

If it does not hold: A transfer cannot move more than the source account holds.
Lower the amount, or choose another account.

## What it changes

| Concept | Operation | Fields |
| --- | --- | --- |
| `Account` | `modify` | `balance` |
| `Transfer` | `create` | `sourceAccountId`, `targetAccountId`, `amount`, `settledOn` |
```

### Where each part of the skill comes from

Every section of `SKILL.md` and `references/<action>.md` maps directly to a key
in your model or binding profile:

```
  the model                              where it lands in the generated skill
  ─────────────────────────────────      ─────────────────────────────────────────
  name, description, actions[].name ───▶ SKILL.md frontmatter + action router table
  ai_context.instructions           ───▶ SKILL.md "## How this model wants to be used"
  entities[].fields                 ───▶ SKILL.md "## Finding a record" (physical
                                           table & column map for looking up keys)
  actions[]:
    name, description               ───▶ references/<action>.md header & summary
    parameters                      ───▶ references/<action>.md "## Arguments"
    ai_context.instructions         ───▶ references/<action>.md "## How to call it"
    guards (constraints[])          ───▶ references/<action>.md "## Rules that
                                           apply to this call"
    affects                         ───▶ references/<action>.md "## What it changes"

  the binding profile                    where it lands in the generated skill
  ─────────────────────────────────      ─────────────────────────────────────────
  deployment_target                 ───▶ SKILL.md "## Finding a record" +
                                           "## Running an action" (Store)
  actions[].executor                ───▶ SKILL.md "## Running an action" (Executor
                                           & whether each action is runnable)
```

*Table 3: which key in your model or binding profile produces each section of
the generated Agent Skill.*

Two sections in `SKILL.md` come from the generator itself:

- **The tool-contract rules in `How this model wants to be used`** — appended
  after your model's `ai_context.instructions` so every skill states the same
  rules once: never invent an identifier, ask the caller or read the store when
  given a name instead of a key, repeat refusal reasons plainly, and always
  report warnings alongside a successful write.
- **`Not runnable under this profile` in `Running an action`** — when an action
  cannot be run under the selected profile, its reference page is still
  generated in full, and `SKILL.md` lists the action with the reason why:
  1. The profile supplies no executor (none declared, or withdrawn with
     `executor: null`).
  2. The executor is `sql` and the profile binds no operational store (`spanner`
     or `alloydb`).
  3. The action names a non-advisory guard that is undeclared in `constraints`
     or has an empty `judgment`.

For all `kcmd skills-generate` flags (`--out`, `--name`, `--profile`, `--force`)
and how the deployment-specific section stays isolated to `SKILL.md`, see
[Generating an Agent Skill](skills.md) and the full end-to-end walkthrough in
`demo/semantic-model/skill/`.

## What is not modeled yet

This is a prototype. Four things you might reasonably expect are absent.

- **Nothing checks a parameter against the column it's compared with.**
  Projecting `source` from `Account.accountId` says what the value is; it says
  nothing about where a statement puts it. `WHERE region = @source` is accepted
  and runs, because the parameter is logical, the column is physical, and no
  rule joins the two. Statements are sent to the store as written — see
  [statements use your database names](#statements-use-your-database-names) —
  so whoever writes one owns which column each argument lands in.
- **A deterministic check over the call's own arguments has no home.** A
  constraint is settled by a model reading it, so `amount <= 25` written as a
  guard costs a model call and can come back differently twice — see
  [what a judgment costs](#what-a-judgment-costs). The place for a check like
  that is likely the action itself; until there is one, keep it in whatever
  dispatches the call, and whoever wrote the statement owns the correctness of
  what it does.
- **Nothing here performs the write.** An action becomes a tool in a generated
  skill, and the agent framework holding that skill is what calls it: a `sql`
  action carries its statements, and an `mcp`, `rest` or `grpc` one carries the
  coordinates of the service that performs it. No code in this repository
  dispatches either.
- **Only a `sql` action needs an operational store.** Its statements are
  written against the database your profile's deployment target names, and only
  Spanner and AlloyDB qualify, so a BigQuery profile lists its `sql` actions as
  not runnable and says why. That profile's `mcp`, `rest` and `grpc` actions are
  offered as tools like any other.
