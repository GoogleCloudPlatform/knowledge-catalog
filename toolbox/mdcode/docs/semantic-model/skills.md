# Generating an Agent Skill

`kcmd skills-generate` compiles a semantic model in the current catalog scope
into an [Agent Skills](https://agentskills.io) package: a directory containing
`SKILL.md` and one `references/<action>.md` page per declared action.

Point `--out` at the skills directory Gemini CLI scans (`.gemini/skills` or
`.agents/skills`), and the agent receives the model's action index, business
rules, physical table/column mappings for looking up keys, and execution
coordinates for the selected binding profile.

## How progressive disclosure works

An Agent Skill separates discovery, routing, and per-action detail so a model
with thirty actions costs the same at startup as a model with one:

1. **Discovery (YAML frontmatter)**: Loaded at session startup (~100 tokens).
   `name` (`<= 64` characters) and `description` (`<= 1,024` characters) tell
   the harness what data the model covers, which actions it declares, and to
   activate the skill when a request asks to change data rather than only read
   it.
2. **Routing (`SKILL.md` body)**: Loaded when the skill activates. Gives the
   agent a one-line-per-action router table (`What you can do here`),
   model-wide instructions (`How this model wants to be used`), how to look
   up record keys and the physical table/column map (`Finding a record`), the
   active profile's store and executor coordinates (`Running an action`), and
   the ways a call can end (`How a call ends`).
3. **Execution (`references/<action>.md`)**: Read on demand only when the agent
   chooses an action from the router table. Contains that action's arguments,
   caller instructions, gating business rules (`guards`), and blast radius
   (`affects`).

Keeping per-action contracts in `references/<action>.md` keeps `SKILL.md` well
inside the Agent Skills 500-line / 5,000-token body budget. If
`model.ai_context.instructions` or a very large schema pushes `SKILL.md` past
those limits, `kcmd skills-generate` warns
(`SKILL.md body is <N> lines, over the 500-line guidance. Move detail into references/.`
or
`SKILL.md body is roughly <N> tokens, over the 5000-token guidance. Move detail into references/.`).

## Quickstart and CLI options

`kcmd skills-generate` reads the catalog scope (`catalog.yaml` and its
`EntryGroups/`) in the **current working directory**. Change into a catalog
directory first, then run `kcmd skills-generate`:

```bash
cd demo/semantic-model/skill
kcmd skills-generate --profile spanner --out .gemini/skills --force
```

This writes two files:

```text
Wrote .gemini/skills/commerce/SKILL.md
Wrote .gemini/skills/commerce/references/issue-credit.md
```

### Flags

All flags are optional:

| Flag | Default | What it does |
| :--- | :--- | :--- |
| `--out <dir>` | `skills` | Parent directory where `<skill-name>/` is written (`<out>/<skill-name>/SKILL.md` and `<out>/<skill-name>/references/*.md`). |
| `--profile <name>` | `default_profile` from `catalog.yaml` | Binding profile from `<model>.profiles/<name>.yaml` used to resolve the physical store, table/column mappings, and action executors. |
| `--name <name>` | Derived from `model.name` | Override the generated skill name (and directory name `<out>/<name>`). Must match `^[a-z0-9]+(-[a-z0-9]+)*$` (lowercase letters, digits, and single hyphens between words, starting and ending with a letter or a digit, max 64 characters). |
| `--force` | `false` | Overwrite an existing `<out>/<skill-name>/` directory and remove any stale `.md` files in `<out>/<skill-name>/references/` left over from renamed or deleted actions. Without `--force`, an existing target directory is refused with `Error: <dir> already exists. Pass --force to rewrite it.` |

If `--name` is not valid, `kcmd skills-generate` refuses before writing any
file:

```text
Error: [commerce] skill name 'Commerce_Demo' is not valid: use lowercase letters, digits and single hyphens, starting and ending with a letter or a digit.
```

If no action in the model is runnable under the selected profile, the skill is
still written so its reference pages can be inspected, and
`kcmd skills-generate` prints a warning to `stderr`:

```text
Warning: [commerce] No action in 'commerce' is runnable under profile 'spanner', so the skill describes 1 action and can run none of them. "Running an action" in the skill gives the reason for each.
```

### Where Gemini CLI discovers skills

Pass one of the following paths to `--out` so Gemini CLI discovers
`<out>/<skill-name>/SKILL.md` automatically:

| Scope | `--out` directory |
| :--- | :--- |
| **Project / workspace scope** | `.gemini/skills` or `.agents/skills` |
| **User scope** | `~/.gemini/skills` or `~/.agents/skills` |

## How the model maps to the generated files

```text
SemanticModel + Binding Profile
│
├── SKILL.md
│   ├── Frontmatter (name, description)  <── model.name, model.description, actions[].name
│   ├── What you can do here             <── actions[].name, actions[].description
│   ├── How this model wants to be used  <── model.ai_context.instructions + tool-contract rules
│   ├── Finding a record                 <── profile store + entities[].fields (table & column map)
│   ├── Running an action                <── active profile, store, actions[].executor
│   └── How a call ends                  <── guards settle first; the endings a call has
│
└── references/<action>.md (one per action, profile-independent)
    ├── Heading & tool name              <── action.name (and snake_case tool name)
    ├── Arguments                        <── action.parameters
    ├── How to call it                   <── action.ai_context.instructions
    ├── Rules that apply to this call    <── action.guards resolved against model.constraints
    └── What it changes                  <── action.affects (concept, operation, fields)
```

## Inside `SKILL.md`

Every snippet below comes directly from running
`kcmd skills-generate --profile spanner` in `demo/semantic-model/skill`.

### Frontmatter (`name` and `description`)

```yaml
---
name: "commerce"
description: "Customers, their orders, and the lines that make up an order. Declares 1 action: IssueCredit. Use when a request asks to change this data rather than only read it."
---
```

- **`name`**: Derived from `model.name` by converting `CamelCase` and
  `snake_case` to lowercase `kebab-case` (or overridden with `--name`). Always
  quoted in YAML frontmatter so names like `on` or `no` are never parsed as
  booleans by YAML 1.1 loaders.
- **`description`**: Built from the first sentence of `model.description`, the
  count and names of declared actions, and the routing sentence
  (`Use when a request asks to change this data rather than only read it.`). If
  a model declares so many actions that the list would exceed the
  1,024-character limit, the action names are abridged
  (`Declares 60 actions: Act1, Act2, and 48 more.`) while keeping the routing
  sentence intact.

### `What you can do here`

Lists one row per action and points the agent to its reference page in
`references/`:

```markdown
| Action | What it does | Reference |
| --- | --- | --- |
| `IssueCredit` | Credit a customer against one order -- a late delivery, a coupon, a shipping charge applied in error. The credit is added as a negative line on the order, and the order's total falls by that much because a total is the sum of its lines. | `references/issue-credit.md` |
```

If a model declares no actions, the router table is replaced by:

```text
This model declares no actions, so there is nothing here to call. It describes what commerce means; it does not offer a way to change it.
```

Only `SKILL.md` is written in that case — no `references/` directory is created
— and `kcmd skills-generate` warns:

```text
Warning: [commerce] Model 'commerce' declares no actions, so the skill describes nothing an agent can do. Generated anyway.
```

This is a different warning from the no-runnable-action one above: that one
fires when actions exist but none can run, this one when the model declares none
at all.

### `How this model wants to be used`

Starts with `ai_context.instructions` from the model (if provided), followed by
the standard contract for identifiers, guards, and warnings:

```markdown
Never invent an identifier. When you are given a name or a description where an action wants a key, ask the caller or read the store directly. Check every rule that gates an action before running it: when a rule says a write must not happen, refuse and explain why; when it says a person has to decide, say so and stop, because you cannot approve it yourself; when an advisory rule goes unmet, report both the change and the warning. Finish by saying what you changed.
```

### `Finding a record`

Actions take keys (`order_id`, `customer_id`), whereas users typically refer to
records by name or date. Without a schema map in `SKILL.md`, an agent given a
database command spends its first turns querying `INFORMATION_SCHEMA`—and if the
map does not explicitly distinguish physical column names from logical model
names, an agent writes `o.customerId` in SQL, hits a column-not-found error, and
falls back to `INFORMATION_SCHEMA` anyway.

When the active profile binds a store, `Finding a record` gives the agent
both the read entry point and the physical schema map:

1. **How to read**: Always stated as a `SELECT` against the store first, and a
   command second — *"To read the store directly, run a `SELECT` against it."*
   Whatever holds the skill may already have a way to run SQL, and a skill
   cannot know what that is called, so a lead that went straight to a shell
   command would tell such a holder to shell out with a better tool in hand.
   What follows the lead is per store:
   - **Spanner (`store.kind === 'spanner'`)**: *"If a shell is what you have:"*
     and then
     `gcloud spanner databases execute-sql <database> --instance=<instance> --project=<project> --sql='SELECT ...'`.
   - **BigQuery (`store.kind === 'bigquery'`)**: the same lead, then
     `bq query --use_legacy_sql=false --project_id=<project> --dataset_id=<dataset> 'SELECT ...'`.
   - **AlloyDB (`store.kind === 'alloydb'`)**: no canned command, and the
     connection named instead — *"This skill supplies no canned CLI command for
     AlloyDB; if a shell is what you have, connect to
     `<project>/<location>/<cluster>/<instance>/<database>` via `psql` or the
     AlloyDB Auth Proxy."*
2. **Physical table and column map**: Lists every bound entity's table reference
   and columns in the store's SQL dialect (`GoogleSQL` for Spanner and BigQuery,
   `PostgreSQL` with quoted identifiers for AlloyDB), labelling each physical
   column `column` and following it with `= Entity.field` and the field's
   description:

```text
Customer -> Customer
  column customer_id (Integer) = Customer.customerId
  column name (String) = Customer.name. The customer's display name, e.g. "Morgan Ellis".
  column email (String) = Customer.email
Order -> Orders
  column order_id (Integer) = Order.orderId. The order's number, which is how both the customer and the desk refer to it.
  column customer_id (Integer) = Order.customerId
  column placed_on (Date) = Order.placedOn. The day the order was placed.
  column total (Decimal) = Order.total. What the customer owes on this order, in dollars.
  column status (String) = Order.status. OPEN or CLOSED.
LineItem -> LineItem
  column line_item_id (String) = LineItem.lineItemId
  column order_id (Integer) = LineItem.orderId
  column type (String) = LineItem.type. item, tax, fee, or credit.
  column amount (Decimal) = LineItem.amount
  column memo (String) = LineItem.memo
```

The table reference is qualified as far as the store requires and no further.
Spanner and AlloyDB resolve an unqualified name against the database the
connection is already on, so the name alone is the whole reference. BigQuery
does not: it resolves an unqualified name against a default dataset, and a
statement sent as a bare query — which is what a skill's holder sends — has
none. So a BigQuery map reads
`` Order -> `my-project.semantic_skill_demo.orders` ``, taking the project and
dataset from the entity's own `source` and falling back to the deployment
target's. A skill that named tables no statement could resolve would be worse
than one that named none, because the reader would believe it.

### `Running an action`

This is the only section in the skill package that describes the deployment
binding rather than the logical model:

- **Store**: `<project>/<instance>/<database>` for Spanner,
  `alloydb:<project>/<location>/<cluster>/<instance>/<database>` for AlloyDB,
  `bigquery:<project>/<dataset>` for BigQuery. When the profile binds no store
  the line is `- Store: none.` followed by the reason, for example `- Store:
  none. Model 'commerce' declares no deployment target under this profile, so
  there is no store to run against. Select a profile whose deployment target
  names a database.`
- **Executor**: The executor kind(s) (`sql`, `mcp`, `rest`, or `grpc`) across
  every action the model *declares*, not only the runnable ones. It is a summary
  of the binding, not a runnability signal: a profile in which nothing can run
  still prints `` - Executor: `sql` `` above the list of reasons why.
- **Remote executor coordinates**: When an action uses a remote executor, its
  target coordinates are printed directly under `Executor`:
  - `mcp`: ``- `PlaceOrder` (`place_order`): MCP tool `place_order` on
    `//agentregistry.googleapis.com/...` ``
  - `rest`: ``- `PlaceOrder` (`place_order`): HTTP `POST`
    `https://api.acme.example/v1/orders` ``
  - `grpc`: ``- `PlaceOrder` (`place_order`): gRPC
    `acme.orders.v1.OrderService/PlaceOrder` ``
- **The statement itself**: Under a `sql` executor each runnable action prints
  its statements verbatim from the profile, under the instruction *"Run what is
  written and nothing else: this is what the model says the action is, and a
  statement composed instead of this one is a write nobody declared and no rule
  was written against."* They are printed exactly as the profile wrote them,
  including a BigQuery profile's fully-qualified table names.
- **Guard evaluation**: Whether an action's guards are settled is a property of
  the model, not a flag on `skills-generate`. An agent framework that exposes
  these actions as tools puts the action's guards to a judge before it sends the
  first statement, and refuses rather than writing unchecked when it cannot
  settle one the model requires.
- **Unrunnable actions (`Not runnable under this profile`)**: An action is
  marked not runnable in `SKILL.md` (while keeping its `references/<action>.md`
  page intact) only when:
  1. It has no executor under the active profile (`executor` omitted or
     withdrawn with `executor: null`).
  2. Its executor is `sql` and the profile binds no store at all.
  3. It names a non-advisory guard that is not declared in `model.constraints`
     or has no `judgment` text.

### `How a call ends`

States when guards are settled, and the endings a call has:
- Every guard is settled **before** the action is performed, not after — a rule
  settled afterwards is not a gate, because the write has landed and there is
  nothing left for it to prevent.
- A call ends in one of three ways, and the section says not to collapse them
  into worked and did not work: **Applied** (say what changed, and how many rows
  changed), **Refused** (repeat the reason plainly; if a person has to decide,
  say so and stop rather than rephrasing the request to get past the rule), or
  **Applied with warnings** (report both — reporting only the success tells the
  caller the write met every rule the model states, which is the one thing it
  did not).
- A fourth outcome is named as not being a failure: a statement was sent and the
  caller cannot tell whether it landed. Say so, say what to read to find out,
  and do not send it again, since a retry that succeeds where the first attempt
  may also have succeeded leaves two of whatever was asked for one of.

## Inside `references/<action>.md`

Each action in `model.actions` generates one file in `references/<slug>.md`.
Reference pages contain **only logical model facts**—no table names, column
names, SQL statements, or store coordinates ever appear on a reference page.

### Heading and tool name

```markdown
# IssueCredit

Action `IssueCredit` of the `commerce` model. As a tool it is named `issue_credit`.
```

When `action.name` differs from its `snake_case` tool name, both are named on
the first line so the agent can match either spelling.

### `Arguments`

Built from `action.parameters`. A parameter projected from an entity or
relationship field (`{concept: Order, field: orderId}`) inherits that field's
scalar type and description unless overridden on the parameter; a standalone
parameter (`{name: memo, type: String}`) uses its own `type`, `required`,
`default`, and `description`:

```markdown
| Name | Type | Required | Identifies | What to pass |
| --- | --- | --- | --- | --- |
| `order` | integer | yes | `Order.orderId` | The order's number, which is how both the customer and the desk refer to it. |
| `amount` | number | yes |  | The amount, as a decimal number. |
| `memo` | string | yes |  | The memo, as text. |
```

**Identifies** carries the projection through rather than collapsing it into the
description, and the table is followed by the sentence that makes it actionable:
*"An argument with something in Identifies is the key of a record that has to
exist already. Find it; do not invent it. 'Finding a record' in SKILL.md says
where to look."* "Never invent an identifier" is only something an agent can act
on against an argument it knows is an identifier, which is what a projection
says and a bare `type` does not.

If any parameter declares a `default`, a `Default` column is included between
`Required` and `Identifies`.

### `How to call it`

Emitted when `action.ai_context.instructions` is present on the action, giving
call-specific instructions (for example, what details must be included in a
`memo` argument so a judged guard can evaluate it).

### `Rules that apply to this call`

Lists every constraint named in `action.guards`, resolved against
`model.constraints`. Each constraint prints its `on_violation` policy, its
`judgment` text as a blockquote, and its `description` under
`If it does not hold:`. The policy is never left as the bare keyword — each of
the three is followed by what it means for the caller, since `escalate` and
`reject` both mean "do not write" and differ only in whether there is anybody to
refer the call to:

- `reject` — *a call that does not satisfy it must not be performed at all.
  There is nobody to refer it to.*
- `escalate` — *a call that does not satisfy it is for a person to decide. Stop
  and say so; do not approve it yourself.*
- `warn` — *this one reports and lets the write through.* The heading also gains
  an `(advisory)` suffix.

```markdown
### CreditUnderReviewThreshold

On violation: `escalate` -- a call that does not satisfy it is for a person to decide. Stop and say so; do not approve it yourself.

> The credit amount requested must not exceed 25 dollars, which is the self-service ceiling for this desk. Read the amount as dollars.

If it does not hold: A credit over $25 is above the self-service ceiling. A supervisor decides it.

### CreditMemoNamesAServiceFailure (advisory)

On violation: `warn` -- this one reports and lets the write through.

> The memo argument of this call must name a specific thing that went wrong on the order: a late delivery, a damaged item, a shipping charge applied in error. A memo saying only that the customer asked, or that the credit is goodwill, or giving no reason at all, names no failure and does not satisfy this rule.

If it does not hold: Say in the credit memo what actually went wrong with the order.
```

### `What it changes`

Renders `action.affects` as a table showing which concepts and fields the action
creates, modifies, or deletes:

```markdown
| Concept | Operation | Fields |
| --- | --- | --- |
| `LineItem` | `create` | `type`, `amount`, `memo` |
```

One row, because `IssueCredit` writes one row. The order's total moves when it
runs and `Order` is still not listed: the total is summed from the lines rather
than stored, so nothing writes it. `affects` declares what a call **writes**,
not everything that will look different afterwards.

## Switching binding profiles (`--profile`)

When a model has multiple binding profiles — `commerce.profiles/spanner.yaml`,
`bigquery.yaml` and `alloydb.yaml` in `demo/semantic-model/skill` — running
`kcmd skills-generate` under each leaves every `references/<action>.md` page
**byte-identical**:

```bash
cd demo/semantic-model/skill
kcmd skills-generate --profile spanner --out /tmp/spanner-skills --force
kcmd skills-generate --profile alloydb --out /tmp/alloydb-skills --force
diff -r /tmp/spanner-skills/commerce/references \
        /tmp/alloydb-skills/commerce/references
```

`diff` exits with `0` and no output. Only `SKILL.md` changes, in
`Finding a record` and `Running an action`:

```diff
--- /tmp/spanner-skills/commerce/SKILL.md
+++ /tmp/alloydb-skills/commerce/SKILL.md
@@ ... @@
-To read the store directly, run a `SELECT` against it. If a shell is what you have:
-
-```bash
-gcloud spanner databases execute-sql semantic_skill_demo \
-  --instance=my-instance --project=my-project \
-  --sql='SELECT ...'
-```
-
-Those are GoogleSQL statements. These are the whole of what there is to read, and the names to write in a statement are the names below -- not the model's own names, which follow each column for cross-reference:
+To read the store directly, run a `SELECT` against it. This skill supplies no canned CLI command for AlloyDB; if a shell is what you have, connect to `my-project/us-central1/my-cluster/my-instance/semantic_skill_demo` via `psql` or the AlloyDB Auth Proxy.
+
+Write PostgreSQL statements. These are the whole of what there is to read, and the names to write in a statement are the names below -- not the model's own names, which follow each column for cross-reference:
 
 ```
-Customer -> Customer
-  column customer_id (Integer) = Customer.customerId
+Customer -> "customer"
+  column "customer_id" (Integer) = Customer.customerId
 ...
-Order -> Orders
+Order -> "purchase_order"
 ...
-  column total (Decimal) = Order.total. What the customer owes on this order, in dollars.
+  column "order_total" (Decimal) = Order.total. What the customer owes on this order, in dollars.
 ...
-LineItem -> LineItem
+LineItem -> "order_line"
 ...
 ```
 
 ## Running an action
 
-Everything above is true of this model wherever it is deployed. This section is not: it describes the binding this skill was generated from, which is profile `spanner`.
+Everything above is true of this model wherever it is deployed. This section is not: it describes the binding this skill was generated from, which is profile `alloydb`.
 
-- Store: `my-project/my-instance/semantic_skill_demo`
+- Store: `alloydb:my-project/us-central1/my-cluster/my-instance/semantic_skill_demo`
 - Executor: `sql`
@@ ... @@
-To perform one of these, run its GoogleSQL below against that store with the call's arguments bound to the named parameters. ...
+To perform one of these, run its PostgreSQL below against that store with the call's arguments bound to the named parameters. ...
 
 ### IssueCredit
 
 ```sql
-INSERT INTO LineItem (line_item_id, order_id, type, amount, memo) VALUES (GENERATE_UUID(), @order, 'credit', -@amount, @memo)
+INSERT INTO order_line (line_item_id, order_id, type, amount, memo) VALUES (gen_random_uuid()::text, @order, 'credit', -@amount, @memo)
 ```
```

Swap `alloydb` for `bigquery` and the same holds, with one extra difference: the
BigQuery map and statement carry a `project.dataset.` prefix the other two do
not, for the reason given under `Finding a record` above.

## What it doesn't generate yet

- **No metrics or relationships in the skill.** `SKILL.md` emits the entity
  table and column map for looking up keys (`Finding a record`) and
  `references/<action>.md` emits the write actions. Declared `metrics` and
  `relationships` are not emitted into the skill package.
- **No plugin manifest or MCP server bundle.** When an action uses an `mcp`,
  `rest`, or `grpc` executor, `SKILL.md` prints its target coordinates
  (`MCP tool <tool> on <server>`, `HTTP <METHOD> <endpoint>`,
  `gRPC <service>/<method>`) so the agent or its harness can call it.
  `kcmd skills-generate` does not emit a plugin manifest or register MCP servers
  with the harness.
- **No CLI runner for actions or judged guards.** `kcmd skills-generate`
  produces the static skill files from the model and profile. `kcmd` performs no
  action and settles no guard: both are the job of the agent framework or tool
  runner that hosts the model's tools.

## See also

- [`actions.md`](actions.md) — declaring actions, parameters,
  `sql`/`mcp`/`rest`/`grpc` executors, `affects`, and judged constraints
  (`guards`).
- [`profiles.md`](profiles.md) — separating logical models from `spanner`,
  `alloydb`, and `bigquery` binding profiles.
- [`reference.md`](reference.md) — full YAML schema reference for semantic
  models.
- [`demo/semantic-model/skill/`](../../demo/semantic-model/skill/README.md) — a
  codelab that generates this skill from `commerce` and hands it to a thin
  Python agent, run live against Spanner and then against BigQuery.
