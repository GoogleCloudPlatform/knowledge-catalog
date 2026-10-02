---
type: Skill
title: "Publish"
description: "Use when a task's deliverable is complete and ready to ship — the gate-keeper that runs every named check (typecheck, lint, test, code review, deploy) and only flips state when each one passes with evidence."
when_to_use:
  - "A story is ready to ship and the gates need to be run"
  - "A milestone boundary needs an evidence line before lock"
when_not_to_use:
  - "The deliverable is still under construction"
tags: [ship, gate, deploy]
status: stable
generated: { by: human:harbor-ops, at: 2026-08-18 }
verified:
  - { by: process:harbor-bundle-parse, at: 2026-08-18 }
  - { by: human:harbor-ops, at: 2026-08-18 }
sources:
  - id: harbor-decisions
    resource: ../decisions.md
    title: "Harbor Skills decisions (the D-NNN decision record)"
  - id: cost-shaped-budget
    resource: ../doctrine/cost-shaped-budget.md
    title: "Cost-Shaped Budget — the principle every dispatch respects"
---

# Publish

## Doctrine

- A gate without evidence is not run. Each gate emits a verdict line, not a vibe.
- A blocker without a fix is a hallway. Every FAIL prints the fix inline.
- Deploys are reversible. The rollback path is the deploy's sibling, not its afterthought.

## Algorithm

0. If the question does not apply, emit `no surface applies - skipping` and stop. Specific to this skill:
   - The deliverable is incomplete. The skill refuses to publish an incomplete deliverable.

1. Identify the named gates the deliverable owes: typecheck, lint, test, code review, deploy.
2. Run each gate in order. Each prints a verdict line (PASS / FAIL / SKIP) with the evidence line.
3. If any gate FAILs, print the fix and stop — do not chain past a FAIL.
4. If all gates PASS, write the ship record (commit hash + gate output + deploy environment).
5. Rollback procedure: emit the environment variable flip + the verification step.

## Judge rubric

- `READY` — all gates PASS with evidence.
- `BLOCKED: <gate-name>` — one gate FAILed; the fix line is included.
- `SKIPPED: <gate-name> = <reason>` — a gate was deliberately skipped.


## Common mistakes

| Mistake | Reality |
|---|---|
| "Looks fine" | The gate's evidence is what proves it — a vibe is not evidence |
| Folding typecheck into lint | They are different gates; merge them and you merge the failure modes |
| Skipping the deploy gate on "well-tested" code | Deploy is a separate failure mode |

## Provenance

Standalone skill. The `Cost-Shaped Budget` doctrine names the principle each gate honors.
