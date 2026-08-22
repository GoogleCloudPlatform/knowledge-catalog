---
type: Doctrine
title: "Restate, Then Investigate"
description: "A candidate is restated in plain language before any investigation runs \u2014 agreement on the candidate precedes investigating its surface."
tags: [doctrine, shape, candidate]
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

# Restate, Then Investigate

## The rule

Before any probe runs, the candidate has been restated in plain language \u2014 no meeting required to read it.

## Why

- **Surface vs shape.** A probe that attacks a partially-shaped candidate gets deflected by the candidate's openness, not its threats. The probe misses both shape failures and surface threats.
- **Shape is cheap paper.** Restating the candidate in one sentence is cheaper than a probe's evidence line; the budget saved returns as clarity later.
- **Shape carries the tests of agreement.** A candidate stated in plain language can be agreed or disagreed in a heartbeat; a verbose candidate gets agreed by nodding, which is not agreement.

## Anti-pattern: a raw candidate into the investigation

> "Here's a 14-page proposal — investigate it."

A 14-page proposal cannot be investigated. It has not been restated as one sentence. The probe attacks surface, not shape; the investigation ceremony replaces methodology.

## Anti-pattern: shape without a probe

A candidate might get shaped but never grilled. Shape → attack → deliver, in order. Skipping a probe means relying on the shape's goodwill; the shape's goodwill doesn't surface bugs.

## When the rule is wrong

- A trivial change (a typo, a one-line tweak). Shape is the existing typo. The probe attacks the typo.
- An emergency. The shape gets skipped. The probe runs serendipitously. The post-mortem brings shape back; the candidate gets shaped *after* the probe, with same effect on the record.

## Provenance

Universal methodology principle. The principle mirrors the discipline any methodology with a probe step adopts. Harbor names it doctrine because every investigation uses it and every investigation documents a restatement check.
