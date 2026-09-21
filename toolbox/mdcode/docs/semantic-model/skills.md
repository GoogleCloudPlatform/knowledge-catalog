# Generating Agent Skills (`kcmd skills-generate`)

`kcmd skills-generate` compiles a semantic model (`SemanticModel`) into an [Agent Skills](https://agentskills.io) package—a directory containing a `SKILL.md` router and one `references/<action>.md` page per declared action.

Point `--out` at the skills directory your agent harness scans (such as `.claude/skills` or `.agents/skills`), and any compatible coding or operations agent gains structured instructions for reading your store, enforcing business constraints, and invoking your model's actions.

---

## How Progressive Disclosure Works

An Agent Skill is structured in three layers so an agent only loads the context it needs for the current turn:

| Layer | What the harness loads | What `kcmd skills-generate` emits |
| :--- | :--- | :--- |
| **1. Discovery** | YAML frontmatter (`name`, `description`) loaded at session startup | The skill name (`<= 64` chars) and a single-paragraph routing description (`<= 1,024` chars) summarizing the model and listing its actions |
| **2. Routing (`SKILL.md`)** | Markdown body of `SKILL.md`, loaded when the user's request matches the skill | An index table of all actions, model-wide instructions, physical table/column mappings for reading records, and the target store/executor coordinates for the active profile |
| **3. Execution (`references/<action>.md`)** | Individual reference file, read on demand when the agent selects a specific action | The full contract for one action: arguments table, caller instructions, gating business rules (`guards`), and blast radius (`affects`) |

Keeping per-action details in `references/<action>.md` ensures that a model with dozens of actions still keeps `SKILL.md` well under the Agent Skills 500-line / 5,000-token body budget.

---

## Quickstart & CLI Reference

Generate a skill from a semantic model file (Markdown with ```yaml blocks or standalone `.yaml`) or directory:

```bash
kcmd skills-generate \
  -i demo/semantic-model/skill/supply_chain.yaml \
  --profile spanner \
  --out .claude/skills \
  --force
```

### CLI Options

| Flag | Required | Default | Description |
| :--- | :---: | :--- | :--- |
| `-i, --input <path>` | Yes | — | Path to a semantic model file (`.md`, `.yaml`, `.yml`) or directory containing one semantic model |
| `--out <dir>` | Yes | — | Parent directory where `<skill-name>/` will be written ( writes `<out>/<skill-name>/SKILL.md` and `<out>/<skill-name>/references/*.md`) |
| `--profile <name>` | No | Model's `default_profile` (or `"default"`) | Binding profile from `binding_profiles` to resolve the physical store, table/column mappings, and action executors |
| `--name <name>` | No | Derived from `model.name` | Override the generated skill name (must match `[a-z0-9-]+`, max 64 characters) |
| `--force` | No | `false` | Delete existing `references/*.md` files in `<out>/<skill-name>/references/` that are no longer emitted before writing |

### Where Agent Harnesses Discover Skills

Pass one of the following paths to `--out` so your agent harness discovers the generated `<skill-name>/SKILL.md` automatically:

| Agent Harness | Project Scope (`--out`) | User Scope (`--out`) |
| :--- | :--- | :--- |
| **Claude Code** | `.claude/skills` | `~/.claude/skills` |
| **Gemini CLI** | `.agents/skills` or `.gemini/skills` | `~/.agents/skills` or `~/.gemini/skills` |
| **Cursor** | `.agents/skills` or `.cursor/skills` | `~/.agents/skills` or `~/.cursor/skills` |

---

## Generated Package Layout

Running `kcmd skills-generate` produces the following directory tree under `<out>`:

```text
<out>/
└── <skill-name>/
    ├── SKILL.md
    └── references/
        ├── <action-1>.md
        └── <action-2>.md
```

### How Model Fields Map to Generated Files

```text
SemanticModel (Logical Model + Binding Profile)
│
├── SKILL.md
│   ├── Frontmatter (name, description)     <── model.name, model.description, actions[].name
│   ├── ## What you can do here             <── actions[].name, actions[].description
│   ├── ## How this model wants to be used  <── model.instructions
│   ├── ## Finding a record                 <── store coordinates + entities[].fields (table & column mappings)
│   ├── ## Running an action                <── active profile, store, actions[].executor
│   └── ## What happens when you call one   <── transaction & guard outcome contract
│
└── references/<action>.md (one per action, profile-independent)
    ├── Heading & tool name                 <── action.name (and snake_case tool name)
    ├── ## Arguments                        <── action.parameters (projected concept/field & standalone)
    ├── ## How to call it                   <── action.instructions
    ├── ## Rules that apply to this call    <── action.guards resolved against model.constraints
    └── ## What it changes                  <── action.affects (concept, operation, fields)
```

---

## Inside `SKILL.md` (The Router)

`SKILL.md` contains everything that applies across the entire model plus the deployment-specific binding for the selected `--profile`.

### 1. Frontmatter (`name` and `description`)

```yaml
---
name: "supply-chain"
description: "Purchase orders, suppliers, and warehouse receiving for retail replenishment. Declares 4 actions: PlacePurchaseOrder,expedite_purchase_order, CancelPurchaseOrder, ReceiveShipment. Use when a request asks to change this data rather than only read it."
---
```

- **`name`**: Derived from `model.name` by converting `CamelCase` and `snake_case` to lowercase `kebab-case` (or overridden via `--name`). Must be 1–64 characters of lowercase ASCII letters, digits, and single hyphens (`[a-z0-9-]+`), matching the parent directory name `<out>/<name>`.
- **`description`**: Combines the first sentence of `model.description`, the count and names of declared actions, and the routing cue (`Use when a request asks to change this data rather than only read it.`). If a model declares many actions and exceeds the 1,024-character Agent Skills limit, the action list is automatically abridged (`Declares 60 actions: Act1, Act2, ..., and 48 more.`) while preserving the routing cue.

### 2. `## What you can do here`

A Markdown table routing the agent from each action to its dedicated reference file:

```markdown
| Action | What it does | Reference |
| --- | --- | --- |
| `PlacePurchaseOrder` | Open a new purchase order with a supplier for a warehouse | `references/place-purchase-order.md` |
| `CancelPurchaseOrder` | Cancel an open purchase order and release its budget reservation | `references/cancel-purchase-order.md` |
```

If a model declares no actions (`actions: []`), this section states that the model is read-only and skips `references/`.

### 3. `## How this model wants to be used`

Emitted when `model.instructions` is present on the semantic model. Use `model.instructions` for cross-cutting rules that apply before any action is chosen (for example: *"Never invent an identifier. When given a supplier name instead of a key, query the store first."*).

### 4. `## Finding a record`

Actions take keys (such as `po_id` or `supplier_id`), whereas users typically ask using names or descriptions. `## Finding a record` gives the agent what it needs to look up records before calling a write action:

1. **Direct query command (Spanner profiles)**: When the profile binds a Spanner store, `SKILL.md` includes a copy-pasteable `gcloud spanner databases execute-sql` command pre-filled with the database, instance, and project.
2. **Physical table and column map**: When the profile binds a store (`spanner`, `alloydb`, or `bigquery`), `SKILL.md` lists every readable entity's physical table name and column names in the store's SQL dialect (`GoogleSQL` for Spanner/BigQuery, `PostgreSQL` for AlloyDB), mapped back to the logical `entity.field` names and field descriptions:

```text
purchase_order -> table purchase_orders
  column po_id (String) = purchase_order.po_id. Primary purchase order identifier, formatted PO-NNNNN.
  column supplier_id (String) = purchase_order.supplier_id. Foreign key to supplier.supplier_id.
  column status (String) = purchase_order.status. Lifecycle state: OPEN, SHIPPED, RECEIVED, or CANCELLED.
```

### 5. `## Running an action`

This section isolates all deployment-specific binding details for the selected `--profile`:

- **Store**: The bound store coordinate (`<project>/<instance>/<database>` for Spanner, `alloydb:<project>/<location>/<cluster>/<instance>/<database>` for AlloyDB, `bigquery:<project>.<dataset>` for BigQuery, or `none`).
- **Executor**: The executor type(s) used by runnable actions (`sql`, `mcp`, `rest`, or `grpc`).
- **Remote executor coordinates**: When an action is backed by an `mcp`, `rest`, or `grpc` executor, its target coordinates are listed directly:
  - `mcp`: ``- `PlaceOrder` (`place_order`): MCP tool `place_order` on `orders-mcp` ``
  - `rest`: ``- `PlaceOrder` (`place_order`): HTTP `POST` `https://api.example.com/v1/orders` ``
  - `grpc`: ``- `PlaceOrder` (`place_order`): gRPC `acme.orders.v1.OrderService/PlaceOrder` ``
- **Unrunnable actions (`Not runnable under this profile`)**: If any action cannot be executed under the chosen profile, `SKILL.md` lists the action and the exact reason why (see [When an Action Is Not Runnable](#when-an-action-is-not-runnable)).

### 6. `## What happens when you call one`

Documents the execution and outcome contract for the agent:
- Every guard rule is evaluated **before** a write transaction is opened, so a rejected or escalated call leaves the store untouched.
- Every call returns one of three states:
  - **Applied**: The write succeeded (report what changed, plus any advisory warnings).
  - **Refused**: A guard rule blocked the call (`reject`) or required human sign-off (`escalate`). The agent must report the reason and stop rather than rephrasing the call to bypass the constraint.
  - **Unknown**: The commit outcome could not be confirmed; the agent must not blindly retry.

---

## Inside `references/<action>.md` (Action Reference Pages)

Each action in `model.actions` gets its own Markdown page under `references/<slug>.md`. Reference pages contain **only logical model facts**—they never contain physical table names, SQL statements, or store coordinates.

### 1. Heading & Tool Name

If the authored action name differs from its `snake_case` tool name (e.g. `PlacePurchaseOrder`), both are shown in the header so the agent can match either convention:

```markdown
# PlacePurchaseOrder

Tool name when exposed as a function call: `place_purchase_order`.

Open a new purchase order with a supplier for a warehouse
```

### 2. `## Arguments`

`kcmd skills-generate` builds the `## Arguments` table from `action.parameters`, distinguishing between parameters projected from an entity/relationship field and standalone call parameters:

| Parameter Kind in `action.parameters` | `Name` | `Type` | `Required` | `Default` | `What it is` |
| :--- | :--- | :--- | :---: | :---: | :--- |
| **Projected parameter** (`{concept: Order, field: orderId}` or `field: Order.orderId`) | `name` (defaults to `field`) | Inherited from `<concept>.<field>` | `yes` if `required !== false` and no `default`; otherwise `no` | `default` value or `—` | `` `<concept>.<field>` `` followed by the parameter's (or field's) `description` |
| **Standalone parameter** (`{name: memo, type: string}`) | `name` | `type` (or `datatype`) | `yes` if `required !== false` and no `default`; otherwise `no` | `default` value or `—` | Parameter `description` (plus ISO-8601 format hint for `date`/`timestamp`) |

### 3. `## How to call it`

Emitted when `action.instructions` is defined. Provides step-by-step guidance specific to calling this action (e.g., how to format identifiers or which fields to verify first).

### 4. `## Rules that apply to this call`

Lists every constraint named in `action.guards`, resolved against `model.constraints`. Each rule's `on_violation` policy is translated into a direct instruction for the agent:

| Constraint `on_violation` | Marker in Reference Page | Agent Behavior |
| :--- | :--- | :--- |
| `reject` | **Must hold — the call is refused if this is not met.** | Do not call the action if the condition is violated; explain why. |
| `escalate` | **Needs a person's approval (`<approver_role>`) — the call will stop and ask for sign-off.** | Stop and ask the user / approver role for explicit sign-off; the agent cannot self-approve. |
| `warn` | **Advisory — a violation is reported as a warning and does not stop the write.** | Proceed with the call if otherwise valid, and report the warning alongside the applied change. |

### 5. `## What it changes`

Summarizes `action.affects` in a blast-radius table so the agent knows which concepts and fields the action creates, updates, or deletes:

```markdown
| Concept | Operation | Fields |
| --- | --- | --- |
| `purchase_order` | `create` | `po_id`, `supplier_id`, `warehouse_id`, `total_amount`, `status`, `created_at` |
```

---

## Switching Binding Profiles (`--profile`)

A semantic model can declare multiple `binding_profiles` (for example, `spanner` for production Cloud Spanner and `alloydb` for an AlloyDB staging environment).

When you run `kcmd skills-generate` with `--profile spanner` vs. `--profile alloydb`:

1. **Every `references/<action>.md` page is byte-identical.** Because an action's arguments, instructions, guards, and affected concepts belong to the logical model, switching databases never alters the reference pages.
2. **Only `SKILL.md` changes**, updating `## Finding a record` (switching the SQL dialect and identifier quoting between `GoogleSQL` and `PostgreSQL`) and `## Running an action` (updating the profile name and store coordinates).

```diff
--- spanner/supply-chain/SKILL.md
+++ alloydb/supply-chain/SKILL.md
@@ -26,28 +26,20 @@
-To read the store directly:
-
-```bash
-gcloud spanner databases execute-sql supply-chain-db \
-  --instance=ops-prod --project=acme-retail \
-  --sql='SELECT ...'
-```
-
-Those are GoogleSQL statements. These tables are the whole of what there is to read, and the names to write in a statement are the table and column names below -- not the model's own names, which follow each column for cross-reference:
+The store uses PostgreSQL. These tables are the whole of what there is to read, and the names to write in a statement are the table and column names below -- not the model's own names, which follow each column for cross-reference:
 
 ```
-purchase_order -> table purchase_orders
-  column po_id (String) = purchase_order.po_id. Primary purchase order identifier, formatted PO-NNNNN.
+purchase_order -> table "purchase_orders"
+  column "po_id" (String) = purchase_order.po_id. Primary purchase order identifier, formatted PO-NNNNN.
 ...
 ```
 
 ## Running an action
 
-Everything above is true of this model wherever it is deployed. This section is not: it describes the binding this skill was generated from, which is profile `spanner`.
+Everything above is true of this model wherever it is deployed. This section is not: it describes the binding this skill was generated from, which is profile `alloydb`.
 
-- Store: `acme-retail/ops-prod/supply-chain-db`
+- Store: `alloydb:acme-retail/us-central1/ops-pg/primary/supply_chain`
 - Executor: `sql`
```

---

## Validation, Warnings & Troubleshooting

### When an Action Is Not Runnable

An action is still included in the router table and still gets a `references/<action>.md` page even if it cannot be executed under the selected profile, so the agent knows the action exists and why it cannot be called. `SKILL.md` lists the reason under `## Running an action`, and `kcmd skills-generate` logs a warning if **no** actions in the model are runnable.

An action is marked **not runnable** under a profile in three cases:

| Condition | Diagnostic in `SKILL.md` | Resolution |
| :--- | :--- | :--- |
| **No executor declared** (`executor` omitted or `executor: null` in the profile) | `Action '<name>' has no executor in this binding profile.` | Add an `executor` (`sql`, `mcp`, `rest`, or `grpc`) to the action or the profile's `actions:` override. |
| **`sql` executor without an operational store** (no store bound, or bound to BigQuery) | `No storage binding in this profile.` or `BigQuery is an analytical store; actions run against Spanner or AlloyDB.` | Pass `--profile <name>` for a profile that binds a `spanner` or `alloydb` store, or switch the action to a remote executor (`mcp`, `rest`, `grpc`). |
| **Invalid or undeclared guard** (a guard in `action.guards` is missing from `model.constraints` or has an empty `judgment`) | `Guard '<name>' on action '<action>' is not declared in model.constraints.` | Declare the constraint in `model.constraints` with a non-empty `judgment`. |

### CLI Warnings & Errors Reference

| Message | Cause | Fix |
| :--- | :--- | :--- |
| `invalid skill name "<name>": ...` | `--name` (or `model.name`) is empty, exceeds 64 characters, or contains characters outside `[a-z0-9-]` | Pass a valid lowercase hyphenated name with `--name <skill-name>`. |
| `refusing to leave N stale file(s) in .../references/ (pass --force to remove): ...` | An action was renamed or removed from the model, leaving an older `.md` file in `references/` | Re-run with `--force` so `kcmd skills-generate` prunes stale files from `references/`. |
| `warning: none of the N action(s) in "<name>" are runnable under profile "<profile>"` | Every action in the model is missing an executor or requires a store not bound by `<profile>` | Select a bound profile with `--profile <name>` or add executors to the model's actions. |
| `warning: SKILL.md is N lines (recommended maximum is 500)...` | `model.instructions` or a very large entity schema pushed `SKILL.md` past 500 lines or ~5,000 tokens | Shorten `model.instructions` or move detailed per-action notes into `action.instructions` (which live in `references/<action>.md`). |
