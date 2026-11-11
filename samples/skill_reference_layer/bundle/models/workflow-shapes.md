---
type: Model
title: "Workflow Shapes"
description: "The four shapes any multi-agent workflow composes — fan-out, pipeline, loop, judge — plus the judge-and-reduce mechanic."
tags: [shapes, orchestration, fan-out]
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
    resource: ./three-moments.md
    title: "Three Moments — the cadence this shape vocabulary fits"
---

# Workflow Shapes

The four shapes — `fan-out`, `pipeline`, `loop`, `judge`. Any multi-agent workflow composes from these.

## Fan-out

> One prompt dispatched to N agents. Each agent runs independently and returns its verdict.

Use for: independent probes over the same candidate; commitment-free opinion collection.

## Pipeline

> A → B → C. Each stage's output is the next stage's input. Stages compose, not parallel.

Use for: Build moments. Extract decisions → lock the spec → dispatch the build → review → ship.

## Loop

> A → B → C → A. The loop terminates on a gate condition; loop without a gate is a leak.

Use for: drill loops that improve with each pass — refinement, verification, repeated grading.

## Judge

> N producers → one reducer → one verdict. The reducer is deterministic.

Use for: code review (producers emit verdict, reducer rules), multi-agent reduction, fan-out findings becoming one finding.

## The judge-and-reduce mechanic

A reducer's job is to:

1. Take multiple findings of the same kind.
2. Deduplicate by location and content.
3. Calibrate severity.
4. Surface a single verdict line.

A judge that errored is not a judge that found nothing — the finding is "the judge broke, not 'no finding'". The error is the finding.

## Composition rules

- A workflow is at most one shape's primary step at a time. A workflow that needs both fan-out and pipeline composes them in sequence, not in parallel.
- A loop without a termination gate is dropped — Harbor does not run open loops.
- A judge on a single producer is wasted — drop the reducer.

## Provenance

Composition vocabulary, drawn from common workflow orchestrators. Harbor uses the four shapes as the menu of allowed moves.
