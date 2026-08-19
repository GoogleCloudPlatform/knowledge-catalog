---
type: Skill
title: "Harbor First Pass"
description: "Use when the task is to receive an intent and route it to one of the more specific skills in the bundle — the entry point that picks between Field Check, Search, Decide, Bootstrap, Publish, or an explicit no-match."
when_to_use:
  - "The user arrived with a free-form ask and the right skill isn't named"
  - "The activation surface needs a single entry per session"
when_not_to_use:
  - "The intent already names a specific skill"
  - "The task is a follow-up to a previous skill's output"
tags: [routing, entry-point]
status: stable
generated: { by: human:harbor-ops, at: 2026-08-18 }
verified:
  - { by: process:harbor-bundle-parse, at: 2026-08-18 }
  - { by: human:harbor-ops, at: 2026-08-18 }
sources:
  - id: harbor-decisions
    resource: ../decisions.md
    title: "Harbor Skills decisions (the D-NNN decision record)"
  - id: okf-spec-4
    resource: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
    title: "OKF v0.2 §4 (concept documents)"
---

# Harbor First Pass

## Doctrine

- **One entry, many skills.** A session that lands here should leave here knowing exactly one skill to invoke next.
- **Say no when the match isn't there.** A wrong match is worse than no match.

## Algorithm

0. If the question does not apply, emit `no surface applies - skipping` and stop. Specific to this skill:
   - The user's intent already names a specific skill → skip; route directly.

1. Take the user's intent as a literal string.
2. Compare against each `when_to_use` keyword in the bundle.
3. If exactly one skill's `when_to_use` matches, route there.
4. If multiple skills match, pick the most specific (most keywords in common).
5. If no skill matches, emit `no-match` and prompt the user to re-state.

## Judge rubric

The skill may emit:

- `route: <skill-name>` — a single skill is selected.
- `route: <skill-a>, <skill-b>` — multiple skills, the first being the primary.
- `no-match` — no skill's `when_to_use` matched the intent.


## Common mistakes

| Mistake | Reality |
|---|---|
| Pushing the closest partial match | Closest is not right — a wrong match burns downstream cycles |
| Routing without reading the trust family | A deprecated or draft skill should not be routed to without flagging |
| Generating a new skill on the fly | A skill not in the bundle isn't a Harbor skill — `no-match` |

## Provenance

- Standalone skill. No upstream skill fold.
