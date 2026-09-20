# Generating an Agent Skill

An **Agent Skill** is a folder an AI agent loads by itself. It holds a `SKILL.md`
— YAML frontmatter naming the skill, then Markdown telling the agent how to do
something — plus any files that Markdown points at. The format is published at
[agentskills.io](https://agentskills.io/) and is read by Claude Code, Cursor,
Gemini CLI and others, so a skill is the portable way to hand an agent a
capability without writing an adapter for each client.

Clients load skills in stages. Every skill's frontmatter is in the agent's
context from the start, which is how it decides a skill is relevant; the body is
read only once it has decided; files the body names are read only if the agent
opens them. That staging is a budget: keep a body under 500 lines and about
5,000 tokens, and put the rest in files beside it.

`kcmd skills-generate` writes a semantic model out in that form. You get a skill
per model, describing the writes the model declares:

```
skills/
└── commerce/
    ├── SKILL.md
    └── references/
        └── issue-credit.md
```

`SKILL.md` is a router — what the business is, one row per action, and the
handful of things true of every call. Each action's arguments, the rules that
gate it and what it changes go in its own reference page, which the agent reads
only when it has picked that action. A model with thirty actions costs the same
at startup as a model with one.

## Generate one

Run it in a semantic-model scope, the same directory `kcmd push` and
`kcmd action run` work in:

```bash
kcmd skills-generate --out skills --judge
```

```
Wrote skills/commerce/SKILL.md
Wrote skills/commerce/references/issue-credit.md
```

| Flag | What it does |
|---|---|
| `--out <dir>` | Directory the skill directories go under. Defaults to `skills` |
| `--name <name>` | Names the skill, and so its directory. Defaults to the model's name. Only for a scope with one model |
| `--profile [name]` | Read the model under this binding profile — it's what the one deployment-specific section describes |
| `--judge [model]` | Write the skill for an agent that holds a judge. Without it, an action guarded by a rule stated in words is described as not runnable |
| `--force` | Replace a skill that's already there |

A skill directory already on disk isn't written into without `--force`. What's
generated is a starting point you're meant to read and may have edited, and a
regeneration that silently replaced those edits would lose work every time the
model changed.

`--force` replaces rather than layers. Renaming an action changes the filename of
its reference page, and the page under the old name is deleted rather than left
behind — staged loading means an agent opens a file under `references/` because
the router pointed at it, but a page nobody points at is still a page it can
read, describing a call the runtime no longer has. Files outside `references/`
stay where they are; a Markdown file under `references/` that the run didn't
write is removed.

Generating a skill that can't run anything is allowed and said out loud. The
description is still true and the actions are still described, so this is the
skill you hand an agent that will hold a judge — but it isn't usually what you
meant to generate:

```
$ kcmd skills-generate --profile spanner
Warning: [commerce] No action in 'commerce' is runnable under profile
'spanner', so the skill describes 1 action and can run none of them. A guarded
action needs a judge: pass --judge if the agent this skill is for holds one.
Wrote skills/commerce/SKILL.md
Wrote skills/commerce/references/issue-credit.md
```

The warning comes before anything is written, so a reader who didn't mean this
still has the chance not to keep it.

The skill's name and its directory name have to match — a client that finds them
different skips the skill, and a plugin wrapping it is required to. So the
generator names the directory from the same string it writes into the
frontmatter, and rejects a name the format doesn't allow before writing
anything:

```
$ kcmd skills-generate --name Commerce_Demo
Error: [commerce] skill name 'Commerce_Demo' is not valid: use lowercase
letters, digits and single hyphens, starting and ending with a letter or a
digit.
```

## What lands in SKILL.md

Frontmatter carries the two fields the format requires and nothing else — the
field set is closed, and a seventh key fails validation:

```yaml
---
name: "commerce"
description: "Customers, their orders, and the lines that make up an order. Declares 1 action: IssueCredit. Use when a request asks to change this data rather than only read it."
---
```

Both values are quoted. A model named `no`, `on` or `y` is a plain YAML 1.1
boolean and one named `2024` is an integer, and most YAML parsers outside
JavaScript still read 1.1 — so an unquoted name reaches a client as something
that isn't a string and no longer matches the directory.

The description is written so the part a client routes on survives: the action
names and the sentence saying when to reach for the skill are composed first, and
a model description too long to fit alongside them is cut down to what's left of
the 1,024 characters the format allows.

Then the model's description, a table of actions, and the model's own
`ai_context.instructions` — what the business wants said to any agent acting on
it, which lives in the model rather than in whoever wrote the agent:

```markdown
| Action | What it does | Reference |
| --- | --- | --- |
| `IssueCredit` | Credit a customer against one order -- a late delivery, a coupon, a … | `references/issue-credit.md` |
```

The row names the action the way it was authored, because that's the string
`kcmd action run` takes and the string a refusal quotes back. The snake_case tool
name a framework would register it under is on the reference page, stated once.

Last comes what the runtime guarantees, which is the same for every model. Every
rule is settled before the write opens a transaction, so a refusal leaves the
store exactly as it was; and a call comes back in one of three states rather
than two — applied, refused, or an outcome nothing can establish. An agent that
reads a refusal as something to retry, or a warning on a successful write as
nothing, gets it wrong the same way against every model, so every skill says it.

## What lands in a reference page

Everything an agent needs before it calls one action: the arguments with their
types, the guidance the action carries, the rules, and the blast radius.

The rules are the part worth looking at. Each one arrives with its own words and
its consequence, and an advisory rule — one whose `on_violation` is `warn` —
is listed and marked as advisory rather than dropped:

```markdown
### CreditMemoNamesAServiceFailure (advisory)

On violation: `warn` -- this one reports and lets the write through.

> The memo argument of this call must name a specific thing that went wrong on
> the order: a late delivery, a damaged item, a shipping charge applied in
> error. …

If it does not hold: Say in the credit memo what actually went wrong with the
order.
```

And what the call reaches, from the action's `affects`:

```markdown
| Concept | Operation | Fields |
| --- | --- | --- |
| `LineItem` | `create` | `type`, `amount`, `memo` |
| `Order` | `modify` | `total` |
```

An action the runtime can't run under this binding is still written out, in
full. Its page doesn't mention it, though. Whether a call can run here is a fact
about the deployment wearing a logical name, so it's collected with the rest of
them in `SKILL.md`, where it can also say which rules the action is waiting on.

## The deployment stays out of the reference pages

An executor is a physical binding — the same `IssueCredit` is DML against
Spanner under one profile and something else under another. So an action's
name, arguments, rules and blast radius are properties of the model, and
nothing under `references/` is about where it runs. What is goes in `SKILL.md`,
almost all of it in one section.

Generate the commerce demo twice, once per profile, and the difference is that
section and nothing else:

````console
$ kcmd skills-generate --judge --profile spanner --out spanner-skills
$ kcmd skills-generate --judge --profile alloydb --out alloydb-skills

$ diff spanner-skills/commerce/references/issue-credit.md \
       alloydb-skills/commerce/references/issue-credit.md

$ diff spanner-skills/commerce/SKILL.md alloydb-skills/commerce/SKILL.md
28,35d27
< To read the store directly:
<
< ```bash
< gcloud spanner databases execute-sql semantic_agent_demo \
<   --instance=my-instance --project=my-project \
<   --sql='SELECT ...'
< ```
<
38c30
< Everything above is true of this model wherever it is deployed. This section is not: it describes the binding this skill was generated from, which is profile `spanner`.
---
> Everything above is true of this model wherever it is deployed. This section is not: it describes the binding this skill was generated from, which is profile `alloydb`.
40c32
< - Store: `my-project/my-instance/semantic_agent_demo`
---
> - Store: `alloydb:my-project/us-central1/my-cluster/my-instance/semantic_agent_demo`
47c39
<   --profile spanner \
---
>   --profile alloydb \
````

The first `diff` prints nothing: the reference page is the same bytes under both
profiles, even though the two databases have different table names, a
differently named column and a different SQL dialect between them. What changes
in `SKILL.md` is the profile, the store, the command line's `--profile`, and the
`gcloud` snippet that only a Spanner store has.

Dropping `--judge` doesn't move the page either, which is the case worth
checking. Whether a guarded action is runnable reads like a property of the
action, and it isn't one — it depends on whether the agent being handed the skill
holds a judge. Generate `commerce` with and without, and the reference page is
again the same bytes; the whole difference is inside that one section, which
either carries a command line or, when nothing here can run, lists each action
with the rules it's waiting on instead.

That section names the profile, the store, the executor kinds in play, and any
action that can't run here. It also carries a `kcmd action run` command line,
built by the same code that prints one under `kcmd action list` — so it arrives
with the flags this action's rules need and a typed placeholder per required
argument, and it's marked, in the skill itself, as the debugging path. `kcmd` is
a command line for inspecting a model, not the runtime an agent should call in
production; an agent that runs continuously should be handed these actions as
tools by its own framework, which reaches the same runtime.

## What it doesn't generate yet

* **Reads.** A skill describes the writes. The lookups a model derives are a
  read path nothing on the command line calls, so rather than pointing an agent
  at a tool that isn't there, the skill says where the key has to come from and,
  for a Spanner store, gives the `gcloud` line that reads it.
* **Metrics.** A metric reaches BigQuery as a `MEASURE`; nothing lowers one into
  a skill.
* **A plugin.** An [Agent Plugin](https://agent-plugins.org/) bundles skills with
  an MCP server and an identity. Its skills are exactly this format — the plugin
  spec delegates to it — so a plugin would wrap what's generated here rather
  than replace it.

## See also

* [Modeling write operations](actions.md) — declaring the actions a skill
  describes, and `kcmd agent tools`, which prints the same derivation instead of
  writing it out
* [Binding profiles](profiles.md) — the profile the deployment-specific section
  reads
