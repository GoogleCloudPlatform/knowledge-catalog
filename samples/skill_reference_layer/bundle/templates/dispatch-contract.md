---
type: Template
title: "Dispatch Contract"
description: "The shape every Harbor dispatch carries to its builder — decision, constraints, acceptance criteria, dependencies, tool budget, target surface."
tags: [dispatch, contract]
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
    title: "Cost-Shaped Budget — the doctrine the tool budget implements"
---

# Dispatch Contract

When Harbor hands work to a builder, the dispatch is structured. The builder does not re-derive the why; it executes. The contract is what the builder sees:

## Required fields

| Field | What it carries |
|---|---|
| `context` | two or three sentences: what exists, what doesn't, relevant files |
| `decision` | the D-NNN (or pending decision) this dispatch implements |
| `constraints` | the patterns this dispatch follows, the things it must avoid |
| `acceptance` | the observable behaviour the dispatch must produce |
| `dependencies` | blocking edges — what must exist before this can run |
| `test` | the test or probe that proves this dispatch succeeded |
| `owner` | the named owner with their clock |
| `tool-budget` | the cost envelope (turns / tokens / wall-clock) — frozen |

## Format

```markdown

# Task: <short name>

## Context
<2-3 sentences>

## Requirements
- <bullet list of what to do>
- <specific files>

## Acceptance Criteria
- AC-001:
  - Scenario: <starting condition>
  - Action: <single trigger>
  - Expected: <observable result>
  - Must not: <prohibited side effect>
  - Verification: <how verified>
  - Priority: Required | Important | Optional

## Risk Review
| Risk area | Applies? | Required handling |
|---|---|---|
| Security/privacy | Yes/No | <handling> |
| Persistent data | Yes/No | <handling> |
| External effects | Yes/No | <handling> |
| Compatibility | Yes/No | <handling> |

## Constraints
- <patterns to follow, things to avoid>

## Tool Budget
<envelope — turns / tokens / wall-clock>

---
```

## Why the template

A builder rederiving the why wastes the budget. A builder that knows the decision, the constraints, the acceptance, the budget is a builder that ships.

## Provenance

Generic dispatch pattern. Harbor uses this for every ticket handed to a builder; the builder's tool budget is the enforced Cost-Shaped Budget doctrine.
