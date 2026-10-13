---
type: Doctrine
title: "Provenance Is The First-Class Citizen"
description: "Every claim cites a source. Without one, it is a guess."
tags: [doctrine, provenance, evidence]
status: stable
generated: { by: human:harbor-ops, at: 2026-08-18 }
verified:
  - { by: process:harbor-bundle-parse, at: 2026-08-18 }
  - { by: human:harbor-ops, at: 2026-08-18 }
sources:
  - id: harbor-decisions
    resource: ../decisions.md
    title: "Harbor Skills decisions (the D-NNN decision record)"
  - id: okf-5
    resource: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
    title: "OKF v0.2 §5 (provenance, trust, lifecycle)"
---

# Provenance Is The First-Class Citizen

A claim without a source is a guess wearing confidence.

## The rule

Every body-text claim in any concept file that asserts a fact about the world, the law, the market, the technical record, the team's history, or the bundle's own decisions carries a citation — by name (a sibling concept) or by URL (an external reference) — alongside the assertion.

The doctrine is enforced:

- **By the source citation in frontmatter** (the `sources` field, for claims about the bundle's own lineage).
- **By markdown footnote references** (for claims about external material — see OKF v0.2 §5.1).
- **By inline references to a sibling concept** (for claims that depend on another concept's body).

A concept whose body asserts unguarded claims — claims that cannot trace to a source — fails the trust family gate. The bundle's two-event verification (D-004) is what catches this in review.

## Why provenance is doctrine, not a recommendation

- A bundle in which claims aren't cited is not trustworthy. The trust family can say it was reviewed; without sources, the review was a vibe.
- The cost of citing is one parenthesis. The cost of not citing is a consumer that has to re-derive.
- A claim's source is auditable, the way a code's test is. A claim that has no source has no test.

## Anti-pattern: "everyone knows this"

> "Concurrency in Go is cheap because goroutines are cheap."

This is true. It is also boring-to-cite, so a writer might write it uncited. The doctrine is: cite it anyway. Either `'Go runtime — concurrency model'` (a pointer to the runtime docs) or `mazzola:go-runtime` (a sibling concept). The cost is one source. The benefit is auditability.

## Anti-pattern: the inline-source block adrift

A claim that includes `Sources: <X>` at the end of a paragraph, but does not include the source in the frontmatter `sources` field, has a citation that can't be parsed by an automated tool. Both places matter; both must be true.

## Provenance

The rule is OKF v0.2 §5 in distilled form — Harbor calls it doctrine because every concept file is held to it, not just the bundles Harbor ships.
