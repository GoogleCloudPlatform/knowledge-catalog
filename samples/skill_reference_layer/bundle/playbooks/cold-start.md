---
type: Playbook
title: "Cold Start Playbook"
description: "The procedure `Bootstrap` runs to hand a new agent the durable state without re-asking prior context."
tags: [playbook, cold-start, resume]
status: stable
generated: { by: human:harbor-ops, at: 2026-08-18 }
verified:
  - { by: process:harbor-bundle-parse, at: 2026-08-18 }
  - { by: human:harbor-ops, at: 2026-08-18 }
sources:
  - id: harbor-decisions
    resource: ../decisions.md
    title: "Harbor Skills decisions (the D-NNN decision record)"
  - id: bootstrap-skill
    resource: ../skills/bootstrap.md
    title: "Bootstrap — the skill that executes this playbook on cold start"
---

# Cold Start Playbook

A session that arrives cold — a fresh agent, the prior session having ended (or died) — runs this procedure before answering any new intent. The procedure is what the **Bootstrap** skill executes; this playbook is its durable surface.

## Procedure

### Step 1 — Pull the durable state

Read (in order):

1. `bundle/decisions.md` — the inline decision record. The agent needs what was decided and why.
2. `bundle/index.md` — the bundle navigator. The agent needs the type cataloguing and which concepts are siblings.
3. `bundle/log.md` — the directory history. The agent needs the change record.

Cumulative read budget: under 4 KB of frontmatter + headers.

### Step 2 — Identify the current ticket

If a current ticket exists in the durable state, identify it. A current ticket is the smallest unblocked, unclaimed work in the ticket map.

If no current ticket exists:

- The intent is greenfield — proceed.
- The intent is a continuation — surface the missing current-ticket before proceeding; do not invent one.

### Step 3 — Compose the cold-start brief

The brief is **self-contained** — a hypothetical fresh agent with no prior session must be able to run the task end-to-end from the brief plus the durable state. The brief contains:

| Section | Source |
|---|---|
| The intent — verbatim | the user's literal request |
| The current ticket — verbatim | the ticket map |
| The decisions that bear on this ticket | `decisions.md` references |
| The trust family of concepts the ticket relies on | `index.md` + each concept's frontmatter |
| The gates the deliverable will owe | `decisions.md` and the relevant Doctrine |

The brief does **not** contain the prior session's transcript, even truncated — transcripts rot and the durable state is the source.

### Step 4 — Hand off

The agent is to:

- Read the brief.
- Read the durable state.
- Execute the current ticket without re-asking what has been decided.

## When this playbook skips

- A session is warm — the context is still coherent. No cold start needed.
- A session is mid-task rotation — same prior context, different model. The brief is unnecessary; the context suffices.

## When this playbook fails

- The durable state is missing. Bootstrap falls back to "the intent + first principles + every referenced concept's full body". This is slow; the bundle author should make the durable state cheap enough to keep around.
- The current ticket is ambiguous. Bootstrap surfaces the ambiguity — it does not pick.

## Provenance

Standard resume-the-work playbook. Harbor keeps it as a Playbook concept rather than embedded in the Bootstrap skill — the skill is a routing engine, the playbook is the procedure.
