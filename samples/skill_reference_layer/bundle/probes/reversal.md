---
type: Probe Prompt
title: "Reversal Probe"
description: "Probe 4 — undo / migrate / exit story: what's the reversal cost?"
tags: [probe-4, reversal, exit]
status: stable
generated: { by: human:harbor-ops, at: 2026-08-18 }
verified:
  - { by: process:harbor-bundle-parse, at: 2026-08-18 }
  - { by: human:harbor-ops, at: 2026-08-18 }
sources:
  - id: harbor-decisions
    resource: ../decisions.md
    title: "Harbor Skills decisions (the D-NNN decision record)"
---

# Reversal Probe

## The probe prompt

```text
You are the reversal probe (probe 4). One view over the same candidate.

Your question. What's the reversal cost?

The candidate (your view). The shipped artifact and the dependency surface that would need un-doing.

What you produce. An exit story — every step is either a ticket or a one-paragraph runbook, and every step has a parallel-run window to make napalm-by-migration impossible.

Verdict vocabulary — per step:
  - ticket        (a Harbor ticket exists for this step)
  - runbook-paragraph (a paragraph lives in docs/runbooks/exit-<system>.md)
  - clock         (the step has an exit_window: hh:mm narration)

Your gate. every step has a ticket / paragraph / clock — no migration-by-napalm (no parallel-run window is a fail).

Skip condition. Skip when the artifact is bounded and explicit (a one-shot script).

Fail-with-the-fix. Every FAIL prints the migration step + the fix + where the runbook paragraph should live.
```

## Common mistakes

| Mistake | Reality |
|---|---|
| Migrating by napalm | A migration without a parallel-run window is a no-migration-or-die |
| "We'll figure it out" | Every step needs a clock and a paragraph, not vibes |

## Provenance

Probe-4 of the candidate's grill.
