---
type: Doctrine
title: "Cost-Shaped Budget"
description: "Every dispatch carries its tool budget; the totals are reviewed before commitment; the budget is part of the contract."
tags: [doctrine, budget, contract]
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

# Cost-Shaped Budget

## The rule

Any dispatch carries the cost envelope (turns / tokens / wall-clock) it was estimated to consume. The estimate is frozen on the dispatch; an overrun escalates to the dispatching layer, not silent expansion.

## Why

- **A budget that doesn't ride the dispatch is a budget that doesn't ride the work.** A builder that doesn't know its envelope will spend more than the envelope; the dispatcher will not see it until after.
- **A tool budget is part of the contract, not a footnote.** The same way a tool's `description` is the activation surface, the budgeted tasks it carries is the cost it commits to.
- **Cost-shaped is not post-shaped.** A budget that runs *before* the work is a commitment check. A budget that runs *after* is a polite estimate of a real cost.

## Anti-pattern: the unbounded dispatch

> "Just figure out the whole thing."

A dispatch without a budget is one that estimates its cost at pick up. The estimate is rarely less than the actual cost.

## Anti-pattern: the refused budget

> "Tell me what it costs and I'll do it."

A refusal to accept a budget is refusal to be accountable for the cost. A budget that ships with the dispatch is non-negotiable. A budget that lands later is a polite estimate.

## When the rule is wrong

- A one-off task that has no follow-on. A budgetless one-off is fine — the cost is whatever it cost. Subsequent tasks earn budgets from this one only by the user explicitly attaching them.
- A research-side question where the budget is the budget of "asking until you have an answer". Here the budget rides differently — turns, not tokens — but it still rides.

## Provenance

Universally applicable project-management principle. Harbor names it doctrine because every dispatch it ships carries a budget by D-NNN default; the publish gate is what catches a builder that overruns silently.
