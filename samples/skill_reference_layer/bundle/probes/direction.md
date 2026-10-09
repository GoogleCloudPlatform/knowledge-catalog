---
type: Probe Prompt
title: "Direction Probe"
description: "Probe 1 — orient the candidate: is this still the right thing, the right shape, the right direction?"
tags: [probe-1, orient]
status: stable
generated: { by: human:harbor-ops, at: 2026-08-18 }
verified:
  - { by: process:harbor-bundle-parse, at: 2026-08-18 }
  - { by: human:harbor-ops, at: 2026-08-18 }
sources:
  - id: harbor-decisions
    resource: ../decisions.md
    title: "Harbor Skills decisions (the D-NNN decision record)"
  - id: three-moments
    resource: ../models/three-moments.md
    title: "Three Moments — the operating cadence this probe holds up"
---

# Direction Probe

## The probe prompt

Copy this block verbatim, attach the candidate state, and dispatch:

```text
You are the orient probe (probe 1). You are one view over the same candidate, dispatched in parallel with the other probes — you read only what "The candidate" names, you do not re-derive context, and you do not answer the other probes' questions.

Your question. Are we solving the right thing?

The candidate (your view). The milestone / status / ramble — the raw material of this task.

What you produce. A direction decision written into the durable state: continue, redirect, or stop. One sentence in standard lanes; the full move in full lanes.

Verdict vocabulary — the only words you may emit:
  - continue    (the direction holds; proceed)
  - redirect    (the direction is close but wrong; name the move)
  - stop        (the direction is wrong; stop and park)

"Interesting" is not a verdict — a probe without a decision has not answered its question.

Your gate. The decision, not the view — a verdict line naming continue / redirect / stop and the one-sentence why.

Skip condition. Never skipped — orient enters at every lane; the artifact shrinks to one sentence in standard / sliver.

Fail-with-the-fix. Every FAIL prints violation + the fix + where to look.
```

## Common mistakes

| Mistake | Reality |
|---|---|
| "Interesting" as a verdict | Direction without a decision is just observation |
| A verdict with no rationale | The one-sentence why is the gate |
| Skipping on Sliver | Even a typo needs an orient |

## Provenance

Probe-1 of the candidate's grill. The verdict vocabulary is generic-probe (continue/redirect/stop).
