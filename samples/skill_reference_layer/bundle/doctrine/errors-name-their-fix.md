---
type: Doctrine
title: "Errors Name Their Fix"
description: "Every FAIL line names the violation, the fix, and where to look — three things on one line, no scope creep."
tags: [doctrine, error, contract]
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

# Errors Name Their Fix

Every FAIL line names the violation, the fix, and where to look. A failure message that names the violation but not the fix is a hallway.

## The rule

A Harbor error is a contract. It carries, on one line:

| Field | What it carries |
|---|---|
| `violation` | what broke — the precise symptom in plain English |
| `fix` | what to do about it — the smallest correct action |
| `where` | where to look — the file, function, line, or row the violation names |

The line is one line. Three sentences cramming into one. A failure that doesn't fit on one line is a sign the violation is too vague — tighten the violation, not the line budget.

## Why

- A failure message that lacks the fix forces a consumer to ask the source ("How do I fix this?" → the source becomes a CHM). A failure message that names the fix is a self-service loop.
- A failure that lacks the `where` is anonymous. Two errors of the same shape in two files have one consumer that can't tell them apart.
- A fix that requires another round trip ("for the fix, see this URL") is a fix that isn't one.

## Anti-pattern: the friendly failure

```
Something broke, please check your configuration.
```

- No violation.
- No fix.
- No where.

A friendly failure is dead. Replace with:

```
fail: <config>.<key> missing — set <config>.<key> to a non-empty string in <config-file>:<line>.
```

## Anti-pattern: the over-engineered failure

```
Sorry, it looks like the validation pipeline failed at stage 4 due to a parameter mismatch.
For detailed information, please consult the troubleshooting guide at https://...
```

This admits every failure looks the same. The `where` is a URL, which is a worse where than a file:line. The `fix` is a URL, which is a worse fix than an inline snippet.

## When the rule is wrong

- A failure caused by an exhaustively-bad-input edge case (a cryptographic failure due to a malformed key) — the violation names the key class, the fix names the key class to use, the `where` is the call site. The line stays one line, but it's a long line.
- A failure during initial bootstrap before Harbor knows `where` it is. The fix is "check whether Harbor is actually started"; the `where` is the exit code; the violation is "Harbor exited without a signal".

## Provenance

Universal linter / CLI contract advice. Harbor keeps it as doctrine because every Gate the bundle ships ranks on this rule — a Gate without it produces noise, not signal.
