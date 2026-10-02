---
type: Model
title: "Three Moments"
description: "The operating cadence — Shape → Build → Deliver. A candidate gets shaped before any probe attacks it; the build front carries a frozen specification; the deliver carries a gate that proved itself."
tags: [cadence, three-moments]
status: stable
generated: { by: human:harbor-ops, at: 2026-08-18 }
verified:
  - { by: process:harbor-bundle-parse, at: 2026-08-18 }
  - { by: human:harbor-ops, at: 2026-08-18 }
sources:
  - id: harbor-decisions
    resource: ../decisions.md
    title: "Harbor Skills decisions (the D-NNN decision record)"
  - id: restate-before-investigate
    resource: ../doctrine/restate-before-investigate.md
    title: "Restate, Then Investigate — the rule this model operationalizes in moment 1"
---

# Three Moments

## Shape → Build → Deliver

The operating cadence that any Harbor task compounds into.

| Moment | What it produces | What blocks its exit |
|---|---|---|
| **Shape** | The shaped candidate — one sentence, no ambiguity, no missing constraint | A candidate that can't be stated in one sentence |
| **Build** | A frozen specification, a ticket map, and the dispatch — the boundary sealed | An unlocked ticket; a budget that doesn't fit capacity |
| **Deliver** | A deliverable whose gates ran clean, a story, a deploy | A BUILD claim without a commit; a gate without evidence |

## Each moment has a sentinel discipline

- Shape: the candidate gets attacked after it's shaped, never before.
- Build: the ticket map's summed budgets are checked against the resource probe's capacity before the boundary seals.
- Deliver: a gate reported without its output is a gate not run.

## Why three, not two or four

- Three compels a real spec step; four turns the cadence into ceremony.
- Two collapses Build into Shape and the deliverable loses its boundary.
- The names (Shape/Build/Deliver) are common planning lexicon and not Harbor-specific; Harbor simply disciplines them.

## Provenance

The cadence is generic. Harbor uses this as its operating tempo; the probe table is indexed by which moment a probe runs in.
