---
type: Doctrine
title: "Read Before You Write"
description: "A consumer that reads the existing artifact before adding a sibling sees the merge-conflict class of issues and skips it."
tags: [doctrine, change-discipline]
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

# Read Before You Write

A consumer that reads the existing artifact before adding a sibling sees the merge-conflict class of issues and skips it. This is the engineering principle Harbor treats as doctrine.

## The rule

Before any **write** — be that a new concept, a new ticket, a new decision-record block, a code change, a comment — **read** the existing surface in the form that the change applies to.

| Action | Read |
|---|---|
| Adding a concept to the bundle | `index.md` and the type-subdirectory you intend to write into |
| Adding a decision record block | The existing `decisions.md` (the whole file, in order) and any decision it might supersede |
| Adding a probe row | The probe table — the existing row shape, the verdict vocabulary, the gate language |
| Changing a SKILL.md | The skill's entire frontmatter + doctrine layer, not just the section you intend to change |
| Changing a code file | The whole module, not the function you intend to patch |

## Why

- **You inherit prior intent.** A new concept that doesn't acknowledge prior concepts is a sibling in name only.
- **You see the seam.** A new sibling that doesn't pick up the right seam becomes the rivet later, not the stitching.
- **You avoid the redundancy class of decisions.** If the same thing has been decided, your decision is repetition, not new.

## When this fails

- A bundle is greenfield. There is nothing to read. This doctrine does not apply — start writing.
- A bundle is read but the read contradicts the writer's instruction. The read wins — the writer asks the human before adding the long-form belief that contradicts the bundle.
- The read is partial (the consumer only read the surface, not the doctrine). Document the partial read; a Doctrine file with "don't apply to this concept" needs to know it.

## Provenance

Generic engineering principle. Harbor treats it as doctrine because it earns its place not by being novel, but by being the cheapest check on the merge-conflict class of mistakes.
