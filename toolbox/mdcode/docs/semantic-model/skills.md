# Generating an Agent Skill

`kcmd skills-generate` compiles a semantic model in the current catalog scope into an [Agent Skills](https://agentskills.io) package: a directory containing `SKILL.md` and one `references/<action>.md` page per declared action.

Point `--out` at the skills directory Gemini CLI scans (`.gemini/skills` or `.agents/skills`), and the agent receives the model's action index, business rules, physical table/column mappings for looking up keys, and execution coordinates for the selected binding profile.

## How progressive disclosure works

An Agent Skill separates discovery, routing, and per-action detail so an agent only loads the context it needs for the current turn:

1. **Discovery (YAML frontmatter)**: Loaded at session startup. `name` (`<= 64` characters) and `description` (`<= 1,024` characters) tell the harness what data the model covers, which actions it declares, and to activate the skill when a request asks to change data rather than only read it.
2. **Routing (`SKILL.md` body)**: Loaded when the skill activates. Gives the agent a table of all actions (`## What you can do here`), model-wide instructions (`## How this model wants to be used`), how to look up record keys and the physical table/column map (`## Finding a record`), the active profile's store and executor coordinates (`## Running an action`), and how pre-commit guard evaluation works (`## What happens when you call one`).
3. **Execution (`references/<action>.md`)**: Read on demand when the agent chooses an action from the table. Contains that action's arguments, caller instructions, gating business rules (`guards`), and blast radius (`affects`).

Keeping per-action contracts in `references/<action>.md` keeps `SKILL.md` well inside the Agent Skills 500-line / 5,000-token body budget even when a model declares dozens of actions.

## Quickstart and CLI options

`kcmd skills-generate` reads the catalog scope (`catalog.yaml` and its `EntryGroups/`) in the **current working directory**. Change into a catalog directory first, then run `kcmd skills-generate`:

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
| `--name <name>` | Derived from `model.name` | Override the generated skill name (and directory name `<out>/<name>`). Must match `[a-z0-9-]+` and be at most 64 characters. |
| `--force` | `false` | Overwrite an existing `<out>/<skill-name>/` directory and remove any stale `.md` files in `<out>/<skill-name>/references/` left over from renamed or deleted actions. |

### Where Gemini CLI discovers skills

Pass one of the following paths to `--out` so Gemini CLI discovers `<out>/<skill-name>/SKILL.md` automatically:

| Scope | `--out` directory |
| :--- | :--- |
| **Project / workspace scope** | `.gemini/skills` or `.agents/skills` |
| **User scope** | `~/.gemini/skills` or `~/.agents/skills` |

## How the model maps to the generated files

```text
SemanticModel + Binding Profile
│
├── SKILL.md
│   ├── Frontmatter (name, description)     <── model.name, model.description, actions[].name
│   ├── ## What you can do here             <── actions[].name, actions[].description
│   ├── ## How this model wants to be used  <── model.ai_context.instructions + tool-contract rules
│   ├── ## Finding a record                 <── profile store + entities[].fields (table & column map)
│   ├── ## Running an action                <── active profile, store, actions[].executor
│   └── ## What happens when you call one   <── pre-commit guard & transaction outcome contract
│
└── references/<action>.md (one per action, profile-independent)
    ├── Heading & tool name                 <── action.name (and snake_case tool name)
    ├── ## Arguments                        <── action.parameters
    ├── ## How to call it                   <── action.ai_context.instructions
    ├── ## Rules that apply to this call    <── action.guards resolved against model.constraints
    └── ## What it changes                  <── action.affects (concept, operation, fields)
```

## Inside `SKILL.md`

Every snippet below comes directly from running `kcmd skills-generate --profile spanner` in `demo/semantic-model/skill`.

### Frontmatter (`name` and `description`)

```yaml
---
name: "commerce"
description: "Customers, their orders, and the lines that make up an order. Declares 1 action: IssueCredit. Use when a request asks to change this data rather than only read it."
---
```

- **`name`**: Derived from `model.name` by converting `CamelCase` and `snake_case` to lowercase `kebab-case` (or overridden with `--name`). Always quoted in YAML frontmatter so names like `on` or `no` are never parsed as booleans by YAML 1.1 loaders.
- **`description`**: Built from the first sentence of `model.description`, the count and names of declared actions, and the routing sentence (`Use when a request asks to change this data rather than only read it.`). If a model declares so many actions that the list would exceed the 1,024-character limit, the action names are abridged (`Declares 60 actions: Act1, Act2, ..., and 48 more.`) while keeping the routing sentence intact.

### `## What you can do here`

Lists one row per action and points the agent to its reference page in `references/`:

```markdown
| Action | What it does | Reference |
| --- | --- | --- |
| `IssueCredit` | Credit a customer against one order -- a late delivery, a coupon, a shipping charge applied in error. The credit is added as a negative line and the order total is recomputed from the lines. | `references/issue-credit.md` |
```

If a model declares no actions, `SKILL.md` states: `This model declares no actions -- it describes data for reading only.`

### `## How this model wants to be used`

Starts with `ai_context.instructions` from the model (if provided), followed by the standard contract for identifiers, guards, and warnings:

```markdown
Never invent an identifier. When you are given a name or a description where an action wants a key, ask the caller or read the store directly. Check every rule that gates an action before running it: when a rule says a write must not happen, refuse and explain why; when it says a person has to decide, say so and stop, because you cannot approve it yourself; when an advisory rule goes unmet, report both the change and the warning. Finish by saying what you changed.
```

### `## Finding a record`

Actions take keys (`order_id`, `customer_id`), whereas users typically refer to records by name or date. When the active profile binds a store, `## Finding a record` gives the agent both the read entry point and the physical schema map:

1. **Read command / connection guidance**:
   - **Spanner (`store.kind === 'spanner'`)**: Emits `gcloud spanner databases execute-sql <database> --instance=<instance> --project=<project> --sql='SELECT ...'`.
   - **BigQuery (`store.kind === 'bigquery'`)**: Emits `bq query --use_legacy_sql=false --project_id=<project> 'SELECT ...'`.
   - **AlloyDB (`store.kind === 'alloydb'`)**: States that the skill supplies no canned CLI command and names `<project>/<location>/<cluster>/<instance>/<database>` for connection via `psql` or the AlloyDB Auth Proxy.
2. **Physical table and column map**: Lists every bound entity's physical table name and columns in the store's SQL dialect (`GoogleSQL` for Spanner and BigQuery, `PostgreSQL` with quoted identifiers for AlloyDB), cross-referenced to the logical `Entity.field` names:

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
```

### `## Running an action`

This is the only section in the skill package that describes the deployment binding rather than the logical model:

- **Store**: `<project>/<instance>/<database>` for Spanner, `alloydb:<project>/<location>/<cluster>/<instance>/<database>` for AlloyDB, `bigquery:<project>/<dataset>` for BigQuery, or `none (<reason>)` when unbound.
- **Executor**: The executor kind(s) (`sql`, `mcp`, `rest`, or `grpc`) across runnable actions.
- **Remote executor coordinates**: When an action uses a remote executor, its target coordinates are printed directly under `Executor`:
  - `mcp`: ``- `PlaceOrder` (`place_order`): MCP tool `place_order` on `//agentregistry.googleapis.com/...` ``
  - `rest`: ``- `PlaceOrder` (`place_order`): HTTP `POST` `https://api.acme.example/v1/orders` ``
  - `grpc`: ``- `PlaceOrder` (`place_order`): gRPC `acme.orders.v1.OrderService/PlaceOrder` ``
- **Unrunnable actions**: When some or all actions cannot run under the active profile, they are listed here with the exact diagnostic reason (see [Diagnostics and error messages](#diagnostics-and-error-messages)).

### `## What happens when you call one`

States the execution and outcome rules:
- Every guard is evaluated **before** opening a write transaction, so a refusal leaves the store untouched.
- Every call returns one of three states: **Applied**, **Refused** (repeat the reason plainly; if a supervisor must decide, stop rather than rephrasing the request to get past the rule), or **Unknown** (the commit could not report its outcome; do not blindly retry).
- If a call comes back **Applied** alongside advisory warnings, the agent must report both the applied change and the warnings.

## Inside `references/<action>.md`

Each action in `model.actions` generates one file in `references/<slug>.md`. Reference pages contain **only logical model facts**—no table names, column names, SQL statements, or store coordinates ever appear on a reference page.

### Heading and tool name

```markdown
# IssueCredit

Action `IssueCredit` of the `commerce` model. As a tool it is named `issue_credit`.
```

When `action.name` differs from its `snake_case` tool name, both are named on the first line so the agent can match either spelling.

### `## Arguments`

Built from `action.parameters`. A parameter projected from an entity or relationship field (`{concept: Order, field: orderId}`) inherits that field's scalar type and description unless overridden on the parameter; a standalone parameter (`{name: memo, type: String}`) uses its own `type`, `required`, `default`, and `description`:

```markdown
| Name | Type | Required | What to pass |
| --- | --- | --- | --- |
| `order` | integer | yes | The order's number, which is how both the customer and the desk refer to it. |
| `amount` | number | yes | The amount, as a decimal number. |
| `memo` | string | yes | The memo, as text. |
```

If any parameter declares a `default`, a `Default` column is included between `Required` and `What to pass`.

### `## How to call it`

Emitted when `action.ai_context.instructions` is present on the action, giving call-specific instructions (for example, what details must be included in a `memo` argument so a judged guard can evaluate it).

### `## Rules that apply to this call`

Lists every constraint named in `action.guards`, resolved against `model.constraints`. Each constraint prints its `on_violation` policy (`reject`, `escalate`, or `warn`), its `judgment` text as a blockquote, and its `description` under `If it does not hold:`:

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

### `## What it changes`

Renders `action.affects` as a table showing which concepts and fields the action creates, modifies, or deletes:

```markdown
| Concept | Operation | Fields |
| --- | --- | --- |
| `LineItem` | `create` | `type`, `amount`, `memo` |
| `Order` | `modify` | `total` |
```

## Switching binding profiles (`--profile`)

When a model has multiple binding profiles (such as `commerce.profiles/spanner.yaml` and `commerce.profiles/alloydb.yaml` in `demo/semantic-model/skill`), running `kcmd skills-generate` under each profile leaves every `references/<action>.md` page **byte-identical**:

```bash
cd demo/semantic-model/skill
kcmd skills-generate --profile spanner --out /tmp/spanner-skills --force
kcmd skills-generate --profile alloydb --out /tmp/alloydb-skills --force
diff /tmp/spanner-skills/commerce/references/issue-credit.md \
     /tmp/alloydb-skills/commerce/references/issue-credit.md
```

`diff` exits with `0` and no output. Only `SKILL.md` changes, in `## Finding a record` and `## Running an action`:

```diff
--- /tmp/spanner-skills/commerce/SKILL.md
+++ /tmp/alloydb-skills/commerce/SKILL.md
@@ -28,34 +28,28 @@
-To read the store directly:
-
-```bash
-gcloud spanner databases execute-sql semantic_skill_demo \
-  --instance=my-instance --project=my-project \
-  --sql='SELECT ...'
-```
+This skill supplies no canned CLI command for AlloyDB; connect to `my-project/us-central1/my-cluster/my-instance/semantic_skill_demo` via `psql` or the AlloyDB Auth Proxy to run `SELECT` queries.
 
-Those are GoogleSQL statements. These tables are the whole of what there is to read, and the names to write in a statement are the table and column names below -- not the model's own names, which follow each column for cross-reference:
+Those are PostgreSQL statements. These tables are the whole of what there is to read, and the names to write in a statement are the table and column names below -- not the model's own names, which follow each column for cross-reference:
 
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

## Diagnostics and error messages

### When an action is marked not runnable in `SKILL.md`

When an action cannot be run under the selected profile, its reference page is still generated in `references/<action>.md`, and `## Running an action` in `SKILL.md` prints one of the following messages:

| Condition | Exact diagnostic in `SKILL.md` |
| :--- | :--- |
| Action has no executor (`executor` omitted or `executor: null`) | `Action '<name>' has no executor under this binding, so there is nothing to run. Give it an executor in the binding profile (or on the action in the model).` |
| `sql` executor, but the profile binds no `deployment_target` | `Model '<model>' has no store under profile '<profile>'.` |
| `sql` executor, but the profile deploys to BigQuery | `This profile deploys to the BigQuery dataset <dataset>, and an action's statements run against an operational database. Select a profile whose deployment target is a Spanner or AlloyDB database.` |
| Guard in `action.guards` is missing from `model.constraints` | `Action '<action>' names guard '<guard>', which is not in the model's constraints.` |
| Non-advisory guard in `action.guards` has an empty `judgment` | `Guard '<guard>' has no 'judgment' text, so there is no rule for the judge to check.` |

### CLI errors and warnings

| Exact CLI message | Cause and resolution |
| :--- | :--- |
| `Error: <dir> already exists. Pass --force to rewrite it.` | The output directory `<out>/<skill-name>` already exists. Re-run with `--force` to overwrite it and prune any stale files in `references/`. |
| `Error: [<model>] Invalid skill name: skill name is empty.` | `model.name` (or `--name`) normalized to an empty string. Pass a valid `--name <name>`. |
| `Error: [<model>] Invalid skill name: skill name '<name>' is <N> characters; the maximum is 64.` | The skill name exceeds the 64-character Agent Skills limit. Pass a shorter `--name <name>`. |
| `Error: [<model>] Invalid skill name: skill name '<name>' must be lowercase ASCII letters, digits, and single hyphens between words (for example, 'retail-sales').` | `--name` contained uppercase letters, underscores, leading/trailing hyphens, or `--`. Use lowercase `kebab-case`. |
| `Warning: [<model>] None of the <N> action(s) in '<model>' can be run under profile '<profile>'; every one is marked not runnable in SKILL.md.` | Every action in the model was refused for one of the reasons in the table above. Select a profile with `--profile <name>` that binds an operational store or defines executors for the actions. |
| `Warning: [<model>] SKILL.md body is <N> lines, over the 500-line guidance. Move detail into references/.` | `model.ai_context.instructions` or a very large entity schema pushed `SKILL.md` past 500 lines. Move per-action instructions into `action.ai_context.instructions`. |
| `Warning: [<model>] SKILL.md body is ~<N> tokens, over the 5000-token guidance. Move detail into references/.` | `SKILL.md` body exceeded `20,000` characters (`~5,000` tokens). Shorten model-level instructions or split the model. |

## What it doesn't generate yet

- **No metrics or relationships in the skill.** `SKILL.md` emits the entity table and column map for looking up keys (`## Finding a record`) and `references/<action>.md` emits the write actions. Declared `metrics` and `relationships` are not emitted into the skill package.
- **No plugin manifest or MCP server bundle.** When an action uses an `mcp`, `rest`, or `grpc` executor, `SKILL.md` prints its target coordinates (`MCP tool <tool> on <server>`, `HTTP <METHOD> <endpoint>`, `gRPC <service>/<method>`) so the agent or its harness can call it. `kcmd skills-generate` does not emit a plugin manifest or register MCP servers with the harness.
- **No CLI runner for actions or judged guards.** `kcmd skills-generate` produces the static skill files from the model and profile. Executing actions and settling judged guards before opening a transaction is performed by the agent framework or tool runner that hosts the model's tools.

## See also

- [`actions.md`](actions.md) — declaring actions, parameters, `sql`/`mcp`/`rest`/`grpc` executors, `affects`, and judged constraints (`guards`).
- [`profiles.md`](profiles.md) — separating logical models from `spanner`, `alloydb`, and `bigquery` binding profiles.
- [`reference.md`](reference.md) — full YAML schema reference for semantic models.
- [`demo/semantic-model/skill/`](../../demo/semantic-model/skill/README.md) — end-to-end walkthrough of `commerce` (`IssueCredit`) under Spanner and AlloyDB profiles.
