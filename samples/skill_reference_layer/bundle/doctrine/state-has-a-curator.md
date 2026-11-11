---
type: Doctrine
title: "State Has a Curator"
description: "Durable state names an owner or it rots. Every durable object the bundle ships must carry a named curator with a clock."
tags: [doctrine, ownership, durable-state]
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

# State Has a Curator

Durable state names an owner or it rots. Every durable object the bundle ships must carry a named curator with a clock.

## The rule

A durable object is anything that outlives a session — a file, a directory, a row in the decision document, a state row, an outbox message, a contract. For each:

- **Curator.** A named role that takes ownership in plain English. Not an alias; not "the team"; not implicit ownership via the upstream skill that wrote it.
- **Clock.** A cadence or deadline. "Reviewed at every milestone boundary" is a clock; "as needed" is not.
- **Escalation path.** A second curator above the first. Two rungs minimum, named.

The triad appears — at minimum — in the durable object's footer or in its frontmatter `verified` list.

## Why

- A file with no curator gets read by the next session as authoritative even if it's stale.
- A decision with no curator gets re-decided by the next fresh context — that's drift; left unchecked, drift is silent, and silent drift destroys the audit trail before anyone notices.
- A row in a ledger with no clock gets reviewed only when it is already an emergency.

## Anti-pattern: the implicit curator

A file's git author is an author. An author is not a curator. Many sessions can author a file. A curator is "who reviews this when?"

A curator must be named in the artifact's surface, not derivable from git. A bundle stripped of git history must still answer "who owns this?"

## Anti-pattern: the all-rubber-stamp curator

> "Curator: the platform team."

The platform team is too large. The curator must be a name that either accepts the role or rejects it. A collective that owns everything owns nothing.

## When the rule is wrong

- An object is ephemeral — generated per request, never persisted. The rule does not apply.
- The bundle's author is still on the project. The author is the curator by default. The rule still applies, but the curator field is "the author" without ceremony.
- The curator is a developer whose whole team has rotated out. The clock is "next touch" — the curator transfers on first contact.

## Provenance

The rule is universal ownership Engineering. Harbor keeps it as doctrine because decision documents grow stale fastest of all durable objects, and stale decisions are how teams re-litigate.
