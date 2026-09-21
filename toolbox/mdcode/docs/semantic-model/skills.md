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
   how pre-commit guard evaluation works (`What happens when you call one`).
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
│   └── What happens when you call one   <── pre-commit guard & transaction outcome contract
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
| `IssueCredit` | Credit a customer against one order -- a late delivery, a coupon, a shipping charge applied in error. The credit is added as a negative line and the order total is recomputed from the lines. | `references/issue-credit.md` |
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

1. **Read command / connection guidance**:
   - **Spanner (`store.kind === 'spanner'`)**: Emits
     `gcloud spanner databases execute-sql <database> --instance=<instance> --project=<project> --sql='SELECT ...'`.
   - **BigQuery (`store.kind === 'bigquery'`)**: Emits
     `bq query --use_legacy_sql=false --project_id=<project> --dataset_id=<dataset> 'SELECT ...'`.
   - **AlloyDB (`store.kind === 'alloydb'`)**: States that the skill supplies no
     canned CLI command and names
     `<project>/<location>/<cluster>/<instance>/<database>` for connection via
     `psql` or the AlloyDB Auth Proxy.
2. **Physical table and column map**: Lists every bound entity's physical table
   name and columns in the store's SQL dialect (`GoogleSQL` for Spanner and
   BigQuery, `PostgreSQL` with quoted identifiers for AlloyDB), labelling each
   physical column `column` and following it with `= Entity.field` and the
   field's description:

```text
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
- **Guard evaluation**: Whether an action's guards are settled is a property of
  the model, not a `--judge` flag on `skills-generate`. An agent framework that
  exposes these actions as tools puts the action's guards to a judge before
  opening a transaction, and refuses rather than writing unchecked when it
  cannot settle one the model requires.
- **Unrunnable actions (`Not runnable under this profile`)**: An action is
  marked not runnable in `SKILL.md` (while keeping its `references/<action>.md`
  page intact) only when:
  1. It has no executor under the active profile (`executor` omitted or
     withdrawn with `executor: null`).
  2. Its executor is `sql` and the profile binds no operational store (`spanner`
     or `alloydb`).
  3. It names a non-advisory guard that is not declared in `model.constraints`
     or has no `judgment` text.

### `What happens when you call one`

States the execution and outcome rules:
- Every guard is evaluated **before** opening a write transaction, so a refusal
  leaves the store untouched.
- Every call returns one of three states: **Applied**, **Refused** (repeat the
  reason plainly; if a supervisor must decide, stop rather than rephrasing the
  request to get past the rule), or **Unknown** (the commit could not report its
  outcome; do not blindly retry).
- If a call comes back **Applied** alongside advisory warnings, the agent must
  report both the applied change and the warnings.

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
| Name | Type | Required | What to pass |
| --- | --- | --- | --- |
| `order` | integer | yes | The order's number, which is how both the customer and the desk refer to it. |
| `amount` | number | yes | The amount, as a decimal number. |
| `memo` | string | yes | The memo, as text. |
```

If any parameter declares a `default`, a `Default` column is included between
`Required` and `What to pass`.

### `How to call it`

Emitted when `action.ai_context.instructions` is present on the action, giving
call-specific instructions (for example, what details must be included in a
`memo` argument so a judged guard can evaluate it).

### `Rules that apply to this call`

Lists every constraint named in `action.guards`, resolved against
`model.constraints`. Each constraint prints its `on_violation` policy (`reject`,
`escalate`, or `warn`), its `judgment` text as a blockquote, and its
`description` under `If it does not hold:`:

```markdown
### CreditUnderReviewThreshold

On violation: `escalate`

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
| `Order` | `modify` | `total` |
```

## Switching binding profiles (`--profile`)

When a model has multiple binding profiles (such as
`commerce.profiles/spanner.yaml` and `commerce.profiles/alloydb.yaml` in
`demo/semantic-model/skill`), running `kcmd skills-generate` under each profile
leaves every `references/<action>.md` page **byte-identical**:

```bash
cd demo/semantic-model/skill
kcmd skills-generate --profile spanner --out /tmp/spanner-skills --force
kcmd skills-generate --profile alloydb --out /tmp/alloydb-skills --force
diff /tmp/spanner-skills/commerce/references/issue-credit.md \
     /tmp/alloydb-skills/commerce/references/issue-credit.md
```

`diff` exits with `0` and no output. Only `SKILL.md` changes, in
`Finding a record` and `Running an action`:

```diff
--- /tmp/spanner-skills/commerce/SKILL.md
+++ /tmp/alloydb-skills/commerce/SKILL.md
@@ ... @@
-To read the store directly:
-
-```bash
-gcloud spanner databases execute-sql semantic_skill_demo \
-  --instance=my-instance --project=my-project \
-  --sql='SELECT ...'
-```
+This skill supplies no canned CLI command for AlloyDB; connect to `my-project/us-central1/my-cluster/my-instance/semantic_skill_demo` via `psql` or the AlloyDB Auth Proxy to run `SELECT` queries.
 
-Those are GoogleSQL statements. These tables are the whole of what there is to read, and the names to write in a statement are the table and column names below -- not the model's own names, which follow each column for cross-reference:
+Write PostgreSQL statements. These tables are the whole of what there is to read, and the names to write in a statement are the table and column names below -- not the model's own names, which follow each column for cross-reference:
 
 ```
-Customer -> table Customer
-  column customer_id (Integer) = Customer.customerId
+Customer -> table "customer"
+  column "customer_id" (Integer) = Customer.customerId
 ...
-Order -> table Orders
+Order -> table "purchase_order"
 ...
-  column total (Decimal) = Order.total. What the customer owes on this order, in dollars.
+  column "order_total" (Decimal) = Order.total. What the customer owes on this order, in dollars.
 ...
-LineItem -> table LineItem
+LineItem -> table "order_line"
 ...
 ```
 
 ## Running an action
 
-Everything above is true of this model wherever it is deployed. This section is not: it describes the binding this skill was generated from, which is profile `spanner`.
+Everything above is true of this model wherever it is deployed. This section is not: it describes the binding this skill was generated from, which is profile `alloydb`.
 
-- Store: `my-project/my-instance/semantic_skill_demo`
+- Store: `alloydb:my-project/us-central1/my-cluster/my-instance/semantic_skill_demo`
 - Executor: `sql`
```

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
  produces the static skill files from the model and profile. Executing actions
  and settling judged guards before opening a transaction is performed by the
  agent framework or tool runner that hosts the model's tools.

## See also

- [`actions.md`](actions.md) — declaring actions, parameters,
  `sql`/`mcp`/`rest`/`grpc` executors, `affects`, and judged constraints
  (`guards`).
- [`profiles.md`](profiles.md) — separating logical models from `spanner`,
  `alloydb`, and `bigquery` binding profiles.
- [`reference.md`](reference.md) — full YAML schema reference for semantic
  models.
- [`demo/semantic-model/skill/`](../../demo/semantic-model/skill/README.md) —
  end-to-end walkthrough of `commerce` (`IssueCredit`) under Spanner and AlloyDB
  profiles.
