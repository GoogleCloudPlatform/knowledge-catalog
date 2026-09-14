# Build an agent that acts on a semantic model

This is a recipe. Follow it and you get an agent that takes a natural language
request and changes a row in an operational store. The point of the recipe is
how little of that turns out to be agent work.

The whole agent is one file, `agent.ts`, 59 lines of code. Not one of them
mentions credits, orders, customers, tables or SQL. The file does four things:
it creates the runtime, derives the tools, adapts them to the framework, and
runs. Everything that knows what business this is lives in the model, and
outlives the agent.

They do not mention a database either. [Step 7](#7-run-the-same-agent-against-alloydb)
runs the identical file against AlloyDB instead of Spanner -- different tables,
a different column name, a different SQL dialect -- by setting one environment
variable.

Everything else you need is already a command: `kcmd` for the model and its
actions, `gcloud` for the store, ADK for the agent.

## The scenario

The business is a small ecommerce operation: customers, their orders, and the
lines that make up an order. There is one thing you can do to it: credit a
customer against an order. Three policy rules say when that is allowed.

[Step 6](#6-run-it) runs the request a support desk gets every day. A customer
was charged for shipping that was supposed to be free, and someone inside the
company has to find the order and put the money back. The request names no
identifier: it gives a customer's name, a holiday, and a description of what
went wrong.

That is the shape worth testing. A request that already speaks in order ids and
line types proves only that the tools can be called.

## Before you start

You need a cloud project and application-default credentials, which serve both
the store and Gemini. Steps 1 to 6 bind the model to Spanner, so the project
needs a Spanner instance. Step 7 does the same against AlloyDB and says what it
needs there; you can stop after step 6 and have a working agent.

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
three entities, the relationships between them, one action, three rules. It
names no table, no column and no SQL. The same file would serve if the orders
lived in another store.

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
at a PostgreSQL database instead. It is not used until [step 7](#7-run-the-same-agent-against-alloydb);
it is mentioned here because it is the reason the split is drawn where it is.
The two profiles disagree about tables, about one column name and about SQL
dialect, and `commerce.yaml` is the same bytes under both.

The files sit in a `kcmd` workspace (`catalog.yaml` scopes it and names
`spanner` as the default profile), so the CLI and the agent read the same files
rather than copies that can drift.

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
    affects:    LineItem (create), Order (modify)
    run:        kcmd action run IssueCredit --arg order=<Order> --arg amount=<Decimal> --arg memo=<String>
```

Two warnings print above this, one for `CreditWithinOrderTotal` and one for
`CreditUnderReviewThreshold`. They are the model reporting on itself, and they
differ only in the constraint they name:

```
Warning: [commerce] model 'commerce': constraint 'CreditWithinOrderTotal' reads 'amount',
a parameter of action 'IssueCredit', but 'IssueCredit' does not list 'CreditWithinOrderTotal'
in guards. A constraint over an action's parameters is checked only as a guard of that action.
```

That is accurate and deliberate — see [What is not wired up
yet](#what-is-not-wired-up-yet).

The action runs from the command line before any agent exists:

```console
$ ../../../dist/kcmd action run IssueCredit --arg order=12346 --arg amount=3.00 --arg memo="Coupon applied late"
Running 'IssueCredit' on projects/my-project/instances/my-instance/databases/semantic_agent_demo...
  order: '12346' -> Order 12346
Committed at 2026-09-12T20:46:28.033336Z.
```

`order=12346` was text; the runtime resolved it to a row and says which one. The
total moved from $18.00 to $15.00 with nobody doing arithmetic, because the
second statement recomputes it from the lines. However the action is called, the
order's total matches its lines. Both statements ran in one read-write
transaction. Read it back with plain SQL:

```console
$ gcloud spanner databases execute-sql semantic_agent_demo \
    --instance=my-instance --project=my-project \
    --sql="SELECT order_id, placed_on, total FROM Orders ORDER BY order_id"
order_id  placed_on   total
12345     2026-09-07  165.85
12346     2026-08-20  15
12347     2026-09-02  200
```

## 4. Look at the tools before writing the agent

`kcmd agent tools` prints exactly what an agent will be handed, before there is
an API key, a language model, or a line of agent code:

```console
$ ../../../dist/kcmd agent tools
Model 'commerce' (commerce_demo), profile 'spanner':
  store: my-project/my-instance/semantic_agent_demo

  action  issue_credit  (IssueCredit)
      Credit a customer against one order -- a late delivery, a coupon, a
      shipping charge applied in error. The credit is added as a negative line
      and the order total is recomputed from the lines.

      Give the order as its number, the amount in dollars, and a memo saying
      why. Look the order up first if you were given a customer name rather
      than a number: an Order is identified by its key alone.
      order: string -- Which Order this applies to. Give its key, or text that
          identifies exactly one; the call fails when nothing matches or more
          than one does.
      amount: number -- The amount, as a decimal number.
      memo: string -- The memo, as text.

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
      you cannot approve it yourself. Finish by saying what you changed.
```

Every line of that came out of the model. The action's description and its
`ai_context.instructions` became the tool description; its typed parameters
became typed tool parameters; each entity's description and bound fields became
a lookup and its filters. The instruction is the model's persona followed by the
tool contract the derivation itself defines.

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

Here is the whole agent: the four steps, with the framework's own API doing the
work:

```ts
// 1. Build the runtime kcmd builds -- the model paired with the store the
//    model says it lives in.
const runtimes = await createSemanticRuntimes({path: import.meta.dir});
if ('error' in runtimes) throw new Error(runtimes.error);
const [runtime] = runtimes;
if (!runtime.store) throw new Error(runtime.storeError);

// 2. Derive what the model offers, and keep what this binding can serve --
//    what `kcmd agent tools` just printed.
const {callable, withheld, instruction} = callableTools(modelTools({runtime}));
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

Step 3 is the only part shaped by ADK rather than by the model, and all it does
is rename fields: a derived parameter already carries a JSON type and a
description, which is the whole of a function declaration. ADK takes a plain
schema object, so there is no schema library in here and nothing to keep in step
with the derivation's types.

Step 2 is one call because every adapter has to make the same split over
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
the two load-time warnings from
[step 3](#3-check-what-the-model-declares) still print first.

```console
$ bun agent.ts "Find the order for Morgan Ellis (morgan.ellis@example.com) that was placed on Labor Day. It was supposed to get free shipping but we had a glitch and the customer got charged. Please issue them a credit to offset the charge."
  -> find_customer({"name":"Morgan Ellis","email":"morgan.ellis@example.com"})
  <- {"entity":"Customer","fields":["customerId","name","email"],"rows":[["1","Morgan Ellis","morgan.ellis@example.com"]],"truncated":false}
  -> find_order({"customerId":1,"placedOn":"2026-09-07"})
  <- {"entity":"Order","fields":["orderId","customerId","placedOn","total","status"],"rows":[["12345","1","2026-09-07","165.85","OPEN"]],"truncated":false}
  -> find_line_item({"orderId":12345,"type":"fee"})
  <- {"entity":"LineItem","fields":["lineItemId","orderId","type","amount","memo"],"rows":[["li-12345-3","12345","fee","30","Shipping"]],"truncated":false}
  -> issue_credit({"memo":"Credit for charged shipping fee on Labor Day order","order":"12345","amount":30})
  <- {"applied":true,"actedOn":{"order":["12345"]},"committedAt":"2026-09-13T18:16:11.020320Z"}
I issued a credit of 30.00 to order 12345 for Morgan Ellis, to offset the shipping charge.
```

The agent made four tool calls, and the request named none of the things they
took. A name and an email became a customer id; a holiday became a date; "the
customer got charged" became a line of type `fee`; the amount to credit was read
off that line rather than supplied. Nowhere does the agent decide *how* to issue
a credit — that is one call, and the model owns what it does.

Check it with SQL:

```console
$ gcloud spanner databases execute-sql semantic_agent_demo \
    --instance=my-instance --project=my-project \
    --sql="SELECT line_item_id, order_id, type, amount, memo FROM LineItem WHERE order_id = 12345 ORDER BY type"
line_item_id                          order_id  type    amount  memo
17d5bf3c-624a-48f6-9556-8243df7c71b7  12345     credit  -30     Credit for charged shipping fee on Labor Day order
li-12345-3                            12345     fee     30      Shipping
li-12345-1                            12345     item    89.99   Cast iron skillet
li-12345-2                            12345     item    34.5    Enamel saucepan
li-12345-4                            12345     tax     11.36   Sales tax
```

The credit exactly offsets the fee, which is what the request asked for. The
credit line's key was generated by the runtime, because the action's `affects`
says the call creates a `LineItem`; the profile's INSERT names it as
`@newLineItemKey`. Order 12345 is $135.85 afterwards, down from $165.85, and
nobody subtracted: the action's second statement re-summed the lines.

What the agent is *not* doing is the more interesting half. It never writes SQL:
the statements are in the binding profile, authored once and reviewed there. It
cannot widen its own reach, because the tools it has are the ones the model
declares. It cannot compute a total — the action does that, in the same
transaction as the write. And it carries no opinion of its own about how to
treat a customer, because that opinion is in `commerce.yaml`.

## 7. Run the same agent against AlloyDB

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

Seventy lines of tools, four tool names, every parameter, every description
and the whole instruction: identical. The two lines that differ are the two that
say which deployment this is. That is the claim, and the `diff` is the proof.

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
request is the one from [step 6](#6-run-it), word for word:

```bash
# From outside the VPC, point the client at the address psql just used.
export ALLOYDB_HOST="$PGHOST"

DEMO_PROFILE=alloydb bun agent.ts "Find the order for Morgan Ellis (morgan.ellis@example.com) that was placed on Labor Day. It was supposed to get free shipping but we had a glitch and the customer got charged. Please issue them a credit to offset the charge."
```

> **Not yet captured.** Every `kcmd` listing on this page, including the `diff`
> above and the push refusal, is copied from a real run. The agent transcript
> against a live AlloyDB cluster is not -- no cluster has been stood up for it
> yet -- so there is no transcript here rather than a plausible one. Everything
> up to the moment a connection opens is exercised by the unit tests; what is
> unproven is the connection itself and the two statements on the other side.

Check the result the same way, in the other dialect:

```bash
psql "host=$PGHOST user=postgres dbname=semantic_agent_demo" -c \
  "SELECT line_item_id, order_id, type, amount, memo
     FROM order_line WHERE order_id = 12345 ORDER BY type"
```

A credit line of `-30.00` with a generated key, and `purchase_order.order_total`
down to `135.85` — the same outcome as
[step 6](#6-run-it), reached by different SQL against different tables, from the
same request through the same agent.

## What in here is about ecommerce

Four files carry the business, and you can list them:

| File | What it holds |
| --- | --- |
| `catalog/EntryGroups/commerce_demo/commerce.yaml` | the ontology, the action, the three policy rules, the persona |
| `catalog/.../commerce.profiles/spanner.yaml` | tables, columns, the two SQL statements, the deployment target |
| `catalog/.../commerce.profiles/alloydb.yaml` | the same four things, for the other database |
| `schema.spanner.sql`, `schema.alloydb.sql` | three `CREATE TABLE`s, twice |
| the seed commands in [step 2](#2-create-the-store) and [step 7](#7-run-the-same-agent-against-alloydb) | two customers, three orders, six lines |

`agent.ts` is not on that list, and neither is anything under `src/`. Swap those
files for a different business and the same 59 lines run it. That is the claim
this demo makes, and the file list is how you check it.

Note which rows doubled and which did not. Moving to a second database added a
profile and a schema; it added no entity, no field, no action, no rule and no
line of agent code.

The list stayed short because of two decisions. This case wanted a filter over a
coded field, and the fix went into `agent_tools.ts`, where it helps every model,
rather than into a hand-written tool here. It also wanted today's date, and that
went into `agent.ts` because it is a fact about the run rather than about
commerce. Each new use case pushes on the boundary in one of those two
directions, and the useful question is always which.

## What is not wired up yet

Start with the thing the run above got wrong. The third policy rule says a
credit over $25 is above the self-service ceiling and a supervisor decides it.
The agent wrote $30 and asked nobody. The agent did not disobey: the policy is
written down and never attached to anything.

`commerce.yaml` declares three constraints, one per policy rule, and references
none of them. A constraint is inert until an action names it in
`guards`, and this runtime does not evaluate constraints yet — so naming one
makes the action *unrunnable* rather than checked. Try it: add
`guards: [CreditUnderReviewThreshold]` to the action and run `kcmd agent tools`
again.

```console
  action  issue_credit  (IssueCredit)  [NOT RUNNABLE]
      ...
      This call is gated by CreditUnderReviewThreshold.

      Calling this will not work: Action 'IssueCredit' is guarded by
      'CreditUnderReviewThreshold', and this runtime does not evaluate
      constraints yet. Running it would apply a write the model says must be
      checked first, so it is refused rather than run unchecked. Report that
      rather than retrying.
      ...
```

Refusing is the point. The model says this write must be checked and the checker
is missing, so the write is refused rather than run unchecked. The tool is still
derived, still named and still described, because an action the model declares
should not vanish from what the model offers. `agent.ts` reports it and leaves
it unbound, so the agent has no call to make and nothing to retry.

Re-run the same request with the guard attached and you get the reading half and
none of the writing half:

```console
$ bun agent.ts "Find the order for Morgan Ellis (morgan.ellis@example.com) that was placed on Labor Day. ..."
(withheld) issue_credit: Action 'IssueCredit' is guarded by 'CreditUnderReviewThreshold', and this runtime does not evaluate constraints yet. Running it would apply a write the model says must be checked first, so it is refused rather than run unchecked.
  -> find_customer({"email":"morgan.ellis@example.com","name":"Morgan Ellis"})
  <- {"entity":"Customer","fields":["customerId","name","email"],"rows":[["1","Morgan Ellis","morgan.ellis@example.com"]],"truncated":false}
  -> find_order({"customerId":1,"placedOn":"2026-09-07"})
  <- {"entity":"Order","fields":["orderId","customerId","placedOn","total","status"],"rows":[["12345","1","2026-09-07","165.85","OPEN"]],"truncated":false}
  -> find_line_item({"orderId":12345,"type":"fee"})
  <- {"entity":"LineItem","fields":["lineItemId","orderId","type","amount","memo"],"rows":[["li-12345-3","12345","fee","30","Shipping"]],"truncated":false}
The customer Morgan Ellis (ID 1) has an order (ID 12345) placed on 2026-09-07. This order includes a shipping fee of $30.00 (line item ID li-12345-3).

I cannot issue credits or modify orders. A person will have to decide how to proceed with the credit.
```

It still did the work worth doing — found the order, found the charge, named the
amount — and order 12345 is still $165.85.

So the demo reaches both ends of the policy story, write and refuse, and not the
middle. There are two rungs where there should be three, and the missing one is
"ask a person, then apply it if they say yes".

The model already says which rule wants that rung. `CreditUnderReviewThreshold`
carries `on_violation: escalate`, and `escalate` means the write is held and an
approver decides. What is missing is not the declaration but anything that acts
on it. Most action frameworks ship a blanket "this action needs confirmation"
flag on the action instead; a rule that escalates only when a predicate is
violated says more, and costs more to honor, because something has to evaluate
the predicate. That evaluator is the next piece of work. The two warnings in
[step 3](#3-check-what-the-model-declares) report the same gap at load time.

The other missing piece is access control. A business that runs an internal desk
agent usually wants a customer-facing one too, restricted to the caller's own
orders. That needs the caller's identity passed in the tool call and checked
below the agent. Only the internal one is here: the lookups take no caller
identity and there is nothing to scope them by, so the second agent cannot be
built from this model today.

## Cleaning up

One command removes it all, because everything the demo made is in the database
the model names.

```bash
gcloud spanner databases delete "$DATABASE" \
  --instance="$INSTANCE" --project="$PROJECT"
```

If you also ran step 7, the AlloyDB cluster is the expensive half and goes
separately. It bills while it exists, so delete it rather than leaving it idle.

```bash
gcloud alloydb clusters delete "$PG_CLUSTER" \
  --region="$PG_REGION" --project="$PG_PROJECT" --force
```
