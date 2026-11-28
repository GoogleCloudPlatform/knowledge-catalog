---
type: Template
title: "Decision Record Block"
description: "The four-key shape every Harbor decision record carries, dropped into the decision document."
tags: [decision-record, template]
status: stable
generated: { by: human:harbor-ops, at: 2026-08-18 }
verified:
  - { by: process:harbor-bundle-parse, at: 2026-08-18 }
  - { by: human:harbor-ops, at: 2026-08-18 }
sources:
  - id: harbor-decisions
    resource: ../decisions.md
    title: "Harbor Skills decisions (the D-NNN decision record)"
  - id: decide-skill
    resource: ../skills/decide.md
    title: "Decide — the skill that emits decision record blocks"
---

# Decision Record Block

Every Harbor decision lands in the decision document as a four-key block:

```markdown

#### D-NNN · <title> — **<status>**

- **context & trade-offs.** What was true and what was considered. Alternatives named.
- **target boundary.** Where the decision lives. The surface the rule protects.
- **machine-enforceable invariant.** A check that proves the rule holds. If a linter / test / job can express it, that is the invariant.

---
```

- `id` (D-NNN): sequential, monotonic, never re-numbered.
- `status`: `Accepted`, `Superseded by D-NNN`, `Deprecated`, or `Rejected`. Superseded decisions stay on disk.
- `context & trade-offs`: the why. Rulings without why aren't decisions; they're just decrees.
- `target boundary`: where the rule applies, named concretely (file path, function, surface).
- `machine-enforceable invariant`: the rule a probe or a linter can express.

## When the template is wrong

- The decision is a one-line ruling with no context → write it in a comment in the code, not in the decision document.
- The rule is a one-paragraph rule with no trade-offs → write it as a Doctrine concept, not as a Decision.
- The rule needs a record that nobody has to refresh → use an inline decision record block.

## Provenance

The four-key shape is the canonical Suggested-Block shape for any decision document Harbor keeps. References: OKF Decision record blocks are not prescriptive in v0.2; Harbor's choice mirrors the inline-block pattern of several long-lived decision documents.
