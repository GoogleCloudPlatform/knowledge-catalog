# Build an agent that acts on a semantic model

This is a recipe, not an exhibit. Follow it and you end up with an agent that
takes an English request and changes a row in Spanner — and with an
understanding of why almost none of the work was agent work.

The whole agent is one file, `agent.ts`, 57 lines of code. Not one of them
mentions credits, orders, customers, Spanner tables or SQL. Four steps: open the
workspace, derive the tools, adapt them to the framework, run. Everything that
knows what business this is lives in the model, where it outlives the agent.

Everything else you need is already a command: `kcmd` for the model and its
actions, `gcloud` for the store, ADK for the agent.

## The scenario is not ours

It is the worked example in *Ontologies, actions and policies — a simple
illustration*: an ecommerce business, three entities, one credit action, three
policy rules, and one specific task posed at the end. Using someone else's
scenario is the point. A demo that invents its own example can quietly shape the
example to fit what the code already does, and the exercise the doc sets —
"how do we concretely represent the ontology, action and policy in this case?" —
is answerable only if the case is fixed first.

So the model below is that prose written down, the seed data is that doc's
order #12345, and [step 6](#6-run-it) runs the doc's task verbatim. Where the
two disagree, the doc is right and this is a bug.

## Before you start

A cloud project with a Spanner instance, and application-default credentials —
used for both Spanner and Gemini.

```bash
gcloud auth application-default login
```

Build the CLI from the `toolbox/mdcode` package root. From step 2 on,
everything runs in `demo/agent`, which is why `kcmd` appears as
`../../dist/kcmd`.

```bash
npm run build                # builds dist/kcmd
(cd demo/agent && npm install)
```

## 1. Write the model

Two files, and the split between them is the whole design.

`catalog/EntryGroups/commerce_demo/commerce.yaml` says what the business is:
three entities, the relationships between them, one action, three rules. It
names no table, no column and no SQL. The same file would serve if the orders
lived in AlloyDB.

`catalog/EntryGroups/commerce_demo/commerce.profiles/spanner.yaml` says where
the business lives: a table per entity, a column per field, and the two
statements that perform `IssueCredit` — insert a negative line, then recompute
the order total from its lines. A profile may supply physical facts and nothing
else; the loader rejects one that tries to add an entity or change what one
means. So reading that one file tells you the whole of what is
deployment-specific here, including where it runs:

```yaml
deployment_target: //spanner.googleapis.com/projects/sqlgen-testing/instances/graph-unified-solution-demo/databases/semantic_agent_demo/propertyGraphs/commerce
```

Point that line at your own instance and everything follows it: the commands
below create and drop the database it names, the tools read and write there, and
the agent bills Gemini to the same project. There is nothing else to keep in
step.

Both files sit in a `kcmd` workspace (`catalog.yaml` scopes it and names
`spanner` as the default profile), so the CLI and the agent read the same two
files rather than two copies that can drift.

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
part that should least be there. It is true of every agent that acts on this
model, including the ones nobody has written yet, and a rule an agent keeps
privately can be changed without the people who own the model finding out.

Only what is specific to *this business* belongs there. How to use a lookup, and
what to do when a write is refused, are properties of the derived tools rather
than of commerce, so the derivation supplies those and the model does not repeat
them.

That persona is the doc's, not a generic one: it distinguishes the internal
agent that can read and write every customer's orders from the customer-facing
agent that can only see its own caller's. Only the first one is built here.

## 2. Create the store

Four `gcloud` commands, and none of them names a database. Ask the model where
it lives instead — `kcmd action list --store` prints the deployment target as
`project/instance/database` and nothing else, so a shell can read it:

```bash
cd demo/agent
IFS=/ read -r PROJECT INSTANCE DATABASE <<<"$(../../dist/kcmd action list --store)"
```

Naming it a second time here is how you end up seeding one database while the
agent talks to another.

```bash
gcloud spanner databases create "$DATABASE" \
  --instance="$INSTANCE" --project="$PROJECT" --ddl-file=schema.sql
```

`schema.sql` is three tables. It is a file rather than a command because
`--ddl-file` wants one, and because `kcmd push` deploys a graph over tables that
already exist rather than creating them.

Then the rows — two customers, three orders, six line items. Order 12345 is the
doc's: Andy Brook's, placed on Labor Day 2026, carrying the $30 shipping charge
that was not supposed to be there.

```bash
gcloud spanner databases execute-sql "$DATABASE" \
  --instance="$INSTANCE" --project="$PROJECT" \
  --sql="INSERT INTO Customer (customer_id, name, email) VALUES
    (1, 'Andy Brook', 'andybrook@gmail.com'),
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
12347 at $200.00. Orders 12346 and 12347 are here so the lookups have something
to discriminate against; nothing in the doc needs them. To start over, drop the
database with the command under [Cleaning up](#cleaning-up) and run these four
again.

## 3. Check what the model declares

```console
$ ../../dist/kcmd action list
Model 'commerce' (commerce_demo), profile 'spanner':
  store: sqlgen-testing/graph-unified-solution-demo/semantic_agent_demo
  IssueCredit: Credit a customer against one order -- a late delivery, a coupon, a shipping charge applied in error. The credit is added as a negative line and the order total is recomputed from the lines.
    parameters: order (Order, reference), amount (Decimal), memo (String)
    executor:   sql
    affects:    LineItem (create), Order (modify)
    run:        kcmd action run IssueCredit --arg order=<Order> --arg amount=<Decimal> --arg memo=<String>
```

Two warnings print above this, and they are the model reporting on itself:

```
Warning: [commerce] model 'commerce': constraint 'CreditWithinOrderTotal' reads 'amount',
a parameter of action 'IssueCredit', but 'IssueCredit' does not list 'CreditWithinOrderTotal'
in guards. A constraint over an action's parameters is checked only as a guard of that action.
```

That is accurate and deliberate — see [What is not wired up
yet](#what-is-not-wired-up-yet).

The action runs from the command line before any agent exists:

```console
$ ../../dist/kcmd action run IssueCredit --arg order=12346 --arg amount=3.00 --arg memo="Coupon applied late"
Running 'IssueCredit' on projects/sqlgen-testing/instances/graph-unified-solution-demo/databases/semantic_agent_demo...
  order: '12346' -> Order 12346
Committed at 2026-09-12T20:46:28.033336Z.
```

`order=12346` was text; the runtime resolved it to a row and says which one. The
total moved from $18.00 to $15.00 with nobody doing arithmetic — the second
statement recomputes it from the lines, so the order cannot stop adding up
however the action is called. Both statements ran in one read-write transaction.
Read it back with plain SQL:

```console
$ gcloud spanner databases execute-sql semantic_agent_demo \
    --instance=graph-unified-solution-demo --project=sqlgen-testing \
    --sql="SELECT order_id, placed_on, total FROM Orders ORDER BY order_id"
order_id  placed_on   total
12345     2026-09-07  165.85
12346     2026-08-20  15
12347     2026-09-02  200
```

## 4. Look at the tools before writing the agent

`kcmd agent tools` prints exactly what an agent will be handed. No API key, no
language model, no agent code yet:

```console
$ ../../dist/kcmd agent tools
Model 'commerce' (commerce_demo), profile 'spanner':
  store: sqlgen-testing/graph-unified-solution-demo/semantic_agent_demo

  action  issue_credit  (IssueCredit)
      Credit a customer against one order -- a late delivery, a coupon, a shipping charge applied in error. The credit is added as a negative line and the order total is recomputed from the lines.

      Give the order as its number, the amount in dollars, and a memo saying why. Look the order up first if you were given a customer name rather than a number: an Order is identified by its key alone.
      order: string  -- Which Order this applies to. Give its key, or text that identifies exactly one; the call fails when nothing matches or more than one does.
      amount: number  -- The amount, as a decimal number.
      memo: string  -- The memo, as text.

  lookup  find_customer  (Customer)
      Look up Customer records.

      Returns customerId, name, email. Every argument is an exact match and every one is optional; giving none returns the first rows. This tool cannot join, compare ranges, or total anything.
      customerId: integer
      name: string  -- The customer's display name, e.g. "Andy Brook".
      email: string

  lookup  find_order  (Order)
      A customer order. Its total is the sum of its line items: items, tax and fees add, credits subtract. A positive total is money owed to the company.

      Returns orderId, customerId, placedOn, total, status. Every argument is an exact match and every one is optional; giving none returns the first rows. This tool cannot join, compare ranges, or total anything.
      orderId: integer
      customerId: integer
      placedOn: string  -- The day the order was placed.
      total: number  -- What the customer owes on this order, in dollars.
      status: string  -- OPEN or CLOSED.

  lookup  find_line_item  (LineItem)
      One line of an order. A charge line is positive; a credit line is negative, so that the order total is always a plain sum.

      Returns lineItemId, orderId, type, amount, memo. Every argument is an exact match and every one is optional; giving none returns the first rows. This tool cannot join, compare ranges, or total anything.
      lineItemId: string
      orderId: integer
      type: string  -- item, tax, fee, or credit.
      amount: number
      memo: string

  instruction:
      You are working an internal operations desk for this business, fixing orders on behalf of the people who run it. A request describes an order the way a person does -- a customer's name, a day, what went wrong -- so expect to be given a description where the model expects a number, and expect to have to read an order's lines to find out what was actually charged.

      Never invent an identifier. When you are given a name or a description instead of one, find it with the lookup tools rather than asking for it -- that is what they are for, and asking wastes the caller's time. Never compute a total or a balance yourself; the tools do that. When a tool reports that a write did not happen, read the reason it gives and repeat it plainly; if it says a person has to decide, say so and stop, because you cannot approve it yourself. Finish by saying what you changed.
```

Every line of that came from somewhere other than an agent. The action's
description and its `ai_context.instructions` became the tool description; its
typed parameters became typed tool parameters; each entity's description and
bound fields became a lookup and its filters. The instruction is the model's
persona followed by the tool contract the derivation itself defines.

Look at `type: string -- item, tax, fee, or credit.` in particular. That line is
the doc's enum, written in `commerce.yaml` as the field's description, and the
only written-down place a caller can learn that a shipping charge is a `fee`.
Until this demo ran the doc's task, the derivation dropped it and put boilerplate
there instead; the agent guessed `type: "shipping"`, got nothing back, and spent
a turn finding out. The fix was in `agent_tools.ts`, not here — every filter over
a coded field had the same hole, in every model.

The read tools are deliberately narrow — exact match on any bound field, ANDed,
capped, no joins, ranges or totals. That is enough to find the object an action
needs, and it keeps the generated SQL checkable by eye. When a lookup is not
enough, the answer is a query, not a wider tool.

## 5. Write the agent

All of it. The four steps, with the framework's own API doing the work:

```ts
// 1. Open the workspace kcmd reads, and the store the model says it lives in.
const opened = await openWorkspace({path: import.meta.dir});
if ('error' in opened) throw new Error(opened.error);
const [{model}] = opened.models;

const store = spannerStore(model);
if ('error' in store) throw new Error(store.error);

// 2. Derive what the model offers, and keep what this binding can serve --
//    what `kcmd agent tools` just printed.
const {callable, withheld, instruction} =
    callableTools(modelTools({model, client: store.client}));
for (const tool of withheld) {
  console.error(`(withheld) ${tool.name}: ${tool.unavailable}`);
}

// 3. Adapt each one to ADK.
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

// 4. Run.
const agent = new LlmAgent({
  name: 'model_agent',
  model: 'gemini-2.5-flash',
  instruction,
  tools,
});
```

Step 3 is the only part that is ADK's shape rather than the model's, and it is a
rename: a derived parameter already carries a JSON type and a description, which
is the whole of a function declaration. ADK takes a plain schema object, so
there is no schema library in here and nothing to keep in step with the
derivation's types.

Step 2 used to be a hand-written filter over `[...lookups, ...actions]`. Every
adapter has to make that same split — a tool the runtime cannot run is still
worth naming, but offering it as callable spends a turn on a call that cannot
succeed — so it moved into `callableTools` in the library, which also makes
dropping `withheld` in silence something you have to choose.

What `agent.ts` adds to the sketch is the loop that prints each call and each
answer, the usage line, and one line appended to the instruction —

```ts
  instruction: `${instruction}\n\nToday is ${
      new Date().toISOString().slice(0, 10)}.`,
```

The doc's request says "Labor Day" and the filter wants `2026-09-07`. Turning one
into the other needs a calendar, which a language model has, and a clock, which
it does not. Without that line the agent guesses a year, drops the filter and
scans, or stops to ask which date you meant — all three happened. With it, three
consecutive runs got `placedOn: "2026-09-07"` on the first try.

It goes in the agent rather than the model on purpose. Today's date is a fact
about when this process is running, not a fact about commerce, and `commerce.yaml`
would be wrong tomorrow. That is the line the file draws, and the test it exists
to fail is the other side of it: the moment something about *this business* has
to be written here, the model was missing that thing, and the fix belongs in the
model.

## 6. Run it

This is the doc's task, word for word:

```console
$ bun agent.ts "Find the order for Andy Brook (andybrook@gmail.com) that was placed on Labor Day. It was supposed to get free shipping but we had a glitch and the customer got charged. Please issue them a credit to offset the charge."
  -> find_customer({"name":"Andy Brook","email":"andybrook@gmail.com"})
  <- {"entity":"Customer","fields":["customerId","name","email"],"rows":[["1","Andy Brook","andybrook@gmail.com"]],"truncated":false}
  -> find_order({"placedOn":"2026-09-07","customerId":1})
  <- {"entity":"Order","fields":["orderId","customerId","placedOn","total","status"],"rows":[["12345","1","2026-09-07","165.85","OPEN"]],"truncated":false}
  -> find_line_item({"orderId":12345,"type":"fee"})
  <- {"entity":"LineItem","fields":["lineItemId","orderId","type","amount","memo"],"rows":[["li-12345-3","12345","fee","30","Shipping"]],"truncated":false}
  -> issue_credit({"memo":"Free shipping credit","order":"12345","amount":30})
  <- {"applied":true,"actedOn":{"order":["12345"]},"committedAt":"2026-09-12T20:53:35.982928Z"}
I have applied a credit of 30 to order 12345 for Andy Brook to offset the shipping charge. The credit memo is "Free shipping credit".
```

Four tool calls, and the request named none of the things they took. A name and
an email became a customer id; a holiday became a date; "the customer got
charged" became a line of type `fee`; the amount to credit was read off that
line rather than supplied. Nowhere does the agent decide *how* to issue a credit
— that is one call, and the model owns what it does.

Check it with SQL:

```console
$ gcloud spanner databases execute-sql semantic_agent_demo \
    --instance=graph-unified-solution-demo --project=sqlgen-testing \
    --sql="SELECT line_item_id, order_id, type, amount, memo FROM LineItem WHERE order_id = 12345 ORDER BY type"
line_item_id                          order_id  type    amount  memo
e2b783f9-566d-4f09-ac91-1fc5544c1680  12345     credit  -30     Free shipping credit
li-12345-3                            12345     fee     30      Shipping
li-12345-1                            12345     item    89.99   Cast iron skillet
li-12345-2                            12345     item    34.5    Enamel saucepan
li-12345-4                            12345     tax     11.36   Sales tax
```

The credit exactly offsets the fee, which is what the request asked for. The
credit line's key was generated by the runtime, because the action's `affects`
says the call creates a `LineItem`; the profile's INSERT names it as
`@newLineItemKey`. Order 12345 is $135.85 afterwards, down from $165.85 — nobody
subtracted, the action's second statement re-summed the lines.

What the agent is *not* doing is the more interesting half. It never writes SQL:
the statements are in the binding profile, authored once and reviewed there. It
cannot widen its own reach, because the tools it has are the ones the model
declares. It cannot compute a total — the action does that, in the same
transaction as the write. And it carries no opinion of its own about how to
treat a customer, because that opinion is in `commerce.yaml`.

## What in here is about ecommerce

Four files, and you can list them:

| File | What it holds |
| --- | --- |
| `catalog/EntryGroups/commerce_demo/commerce.yaml` | the ontology, the action, the three policy rules, the persona |
| `catalog/.../commerce.profiles/spanner.yaml` | tables, columns, the two SQL statements, the deployment target |
| `schema.sql` | three `CREATE TABLE`s |
| the seed commands in [step 2](#2-create-the-store) | Andy Brook's order |

`agent.ts` is not on that list, and neither is anything under `src/`. Swap those
four for a different business and the same 57 lines run it — that is the claim
this demo is making, and the file list is how you check it.

Two things are worth knowing about how short that list stayed. The doc's case
wanted a filter over a coded field, and the fix went into `agent_tools.ts` where
it helps every model, rather than into a hand-written tool here. The doc's case
also wanted today's date, and that went into `agent.ts` because it is a fact
about the run rather than about commerce. Each new use case pushes on the
boundary in one of those two directions; the useful question is always which.

## What is not wired up yet

Start with the thing the run above got wrong. The doc's third rule says a credit
of $25 or more needs a person to approve it, and the doc's own walkthrough sends
this $30 credit to a review queue. The run above wrote it. That is not the agent
disobeying — it is the policy being written down and not attached.

`commerce.yaml` declares three constraints, one per rule in the doc, and
references none of them. A constraint is inert until an action names it in
`guards`, and this runtime does not evaluate constraints yet — so naming one
makes the action *unrunnable* rather than checked. Try it: add
`guards: [CreditUnderReviewThreshold]` to the action and run `kcmd agent tools`
again.

```console
  action  issue_credit  (IssueCredit)
      ...
      This call is gated by CreditUnderReviewThreshold.

      Calling this will not work: Action 'IssueCredit' is guarded by 'CreditUnderReviewThreshold', and this runtime does not evaluate constraints yet. Running it would apply a write the model says must be checked first, so it is refused rather than run unchecked. Report that rather than retrying.
      ...
      NOT RUNNABLE: Action 'IssueCredit' is guarded by 'CreditUnderReviewThreshold', ...
```

Refusing is the point. A write the model says must be checked is not run because
the checker is missing; it is not run *unchecked*. The tool is still derived,
still named and still described — an action the model declares should not vanish
from what the model offers — and `agent.ts` reports it and leaves it unbound, so
the agent has no call to make and nothing to retry.

Re-run the doc's task with the guard attached and you get the reading half and
none of the writing half:

```console
$ bun agent.ts "Find the order for Andy Brook (andybrook@gmail.com) that was placed on Labor Day. ..."
(withheld) issue_credit: Action 'IssueCredit' is guarded by 'CreditUnderReviewThreshold', and this runtime does not evaluate constraints yet. Running it would apply a write the model says must be checked first, so it is refused rather than run unchecked.
  -> find_customer({"name":"Andy Brook","email":"andybrook@gmail.com"})
  <- {"entity":"Customer","fields":["customerId","name","email"],"rows":[["1","Andy Brook","andybrook@gmail.com"]],"truncated":false}
  -> find_order({"customerId":1,"placedOn":"2026-09-07"})
  <- {"entity":"Order","fields":["orderId","customerId","placedOn","total","status"],"rows":[["12345","1","2026-09-07","165.85","OPEN"]],"truncated":false}
  -> find_line_item({"orderId":12345,"type":"fee"})
  <- {"entity":"LineItem","fields":["lineItemId","orderId","type","amount","memo"],"rows":[["li-12345-3","12345","fee","30","Shipping"]],"truncated":false}
I found that Andy Brook (customer ID 1) was charged $30 for shipping on order 12345, placed on 2026-09-07 (Labor Day). The line item ID for this charge is li-12345-3. I cannot directly issue a credit to offset this charge with the tools I have.
```

It still did the work worth doing — found the order, found the charge, named the
amount — and order 12345 is still $165.85.

So the demo can reach either end of the doc's policy story and not the middle:
write, or refuse. There are two rungs where there should be three, and the
missing one is "ask a person, then apply it if they say yes".

The model already says which rule wants that rung. `CreditUnderReviewThreshold`
carries `on_violation: escalate`, and `escalate` means the write is held and an
approver decides. What is missing is not the declaration but anything that acts
on it. Most action frameworks ship a blanket "this action needs confirmation"
flag on the action instead; a rule that escalates only when a predicate is
violated says more, and costs more to honor, because something has to evaluate
the predicate. That evaluator is the next piece of work. The two warnings at
load time are the same gap, stated at load time.

The other thing the doc has and this does not is its Data Access Controls. There
are meant to be two agents over this model — an internal one that reads and
writes every customer's orders, and a customer-facing one restricted to its own
caller, with the identity passed in the tool call and checked below the agent.
Only the internal one is here. The lookups take no caller identity and there is
nothing to scope them by, so the second agent cannot be built from this model
today.

## Cleaning up

One command. Everything the demo made is in the database the model names.

```bash
gcloud spanner databases delete "$DATABASE" \
  --instance="$INSTANCE" --project="$PROJECT"
```
