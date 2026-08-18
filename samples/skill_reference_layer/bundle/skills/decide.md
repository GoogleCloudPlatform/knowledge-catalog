---
type: Skill
title: "Decide"
description: "Use when handed raw material that must become named decisions — a meeting transcript, a brainstorm dump, an unstructured ask — and the decisions must carry rationale, an owner, a clock, and a record that outlives any session."
when_to_use:
  - "Extract decisions from a transcript or ramble"
  - "Confirm a set of decisions before they lock"
when_not_to_use:
  - "The decisions already exist as a record"
tags: [decision, decision-record]
status: stable
generated: { by: human:harbor-ops, at: 2026-08-18 }
verified:
  - { by: process:harbor-bundle-parse, at: 2026-08-18 }
  - { by: human:harbor-ops, at: 2026-08-18 }
sources:
  - id: harbor-decisions
    resource: ../decisions.md
    title: "Harbor Skills decisions (the D-NNN decision record)"
  - id: decision-record-block
    resource: ../templates/decision-record-block.md
    title: "Decision Record Block template — the four-key shape every record carries"
---

# Decide

## Doctrine

- A decision is its rationale, not its ruling. The why is the record.
- An owner is a name and a clock. Both, never one without the other.
- Durability over ceremony. The record outlives any session.

## Algorithm

1. Read the raw material end-to-end. Drop noise (anything that is not a claim or a question). Keep claims and questions.
2. For each claim: bucket it — decision / action / open question / noise.
3. For every decision bucket entry, write the four-key block (id, status, context, boundary, invariant).
4. For every action bucket entry, name the owner and the by-when.
5. For every open question, escalate — do not let a question become a silent decision.
6. Confirm with the human. The skill does not lock without confirmation.

## Judge rubric

The skill emits one of:

- `decision-table: N entries` — N decisions captured with four-key blocks.
- `open-questions: K` — K items escalated, not silenced.
- `noise-dropped: M items` — M items dropped with named reason.

## Skip conditions

- The input already arrives as a decision record — `no surface applies`.

## Common mistakes

| Mistake | Reality |
|---|---|
| Decisions without rationale | The record without the why is a ruling, not a decision |
| "TBD" on the owner | A decision without a named owner is an anonymous one |
| Silencing open questions | A loud open question is better than a silent decision |

## Provenance

Folds from the `Decision Record Block` template for the four-key shape.
