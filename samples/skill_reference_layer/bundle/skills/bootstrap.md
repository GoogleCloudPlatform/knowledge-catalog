---
type: Skill
title: "Bootstrap"
description: "Use when starting a fresh context for a task — the cold-start protocol that hands a new agent the durable-state surface (decisions, plan, progress, the relevant concepts) so the task can be picked up without re-asking prior context."
when_to_use:
  - "A session is dying and the next session will resume"
  - "A new task begins from a known current ticket"
when_not_to_use:
  - "Mid-task, the context is still warm"
tags: [resume, cold-start]
status: stable
generated: { by: human:harbor-ops, at: 2026-08-18 }
verified:
  - { by: process:harbor-bundle-parse, at: 2026-08-18 }
  - { by: human:harbor-ops, at: 2026-08-18 }
sources:
  - id: harbor-decisions
    resource: ../decisions.md
    title: "Harbor Skills decisions (the D-NNN decision record)"
  - id: cold-start-playbook
    resource: ../playbooks/cold-start.md
    title: "Cold Start Playbook — the procedure the skill executes"
---

# Bootstrap

## Doctrine

- Context is durable state, not transcript. Play back the artifacts, not the conversation.
- A cold-start brief must be self-contained. A fresh agent with no prior session must be able to run the task.
- The brief names the current ticket, not the prior history. History is consulted, not recreated.

## Algorithm

1. Read durable state: the decision record, the plan, the progress ledger.
2. Identify the current position — the first open, unblocked, unclaimed ticket.
3. Compose a context brief: that ticket's contract section + the decisions that bear on it + the trust family of any concept the ticket relies on.
4. Hand the brief to the new agent. Stop. Do not seed it with opinions about the prior session.

## Judge rubric

- `bootstrap: <brief handed off, current=<ticket>>` — the cold-start is complete.

## Skip conditions

- The task is mid-session and the context is still warm — `no surface applies`.

## Common mistakes

| Mistake | Reality |
|---|---|
| Re-deriving the prior session | Warm context rots; durable state is the source |
| Missing the trust family | Relying on a deprecated concept without flagging it costs more than flags |
| Handing off more than the brief | The new agent now has the prior's noise, not the prior's lessons |

## Provenance

Folds from the `Cold Start Playbook` for the procedure, and the `Decision Record` for the rules the brief must respect.
