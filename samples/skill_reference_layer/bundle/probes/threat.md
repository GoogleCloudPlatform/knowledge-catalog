---
type: Probe Prompt
title: "Threat Probe"
description: "Probe 3 — attack surface and STRIDE classification: can we secure it?"
tags: [probe-3, security, threat]
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

# Threat Probe

## The probe prompt

```text
You are the threat-model probe (probe 3). One view over the same candidate.

Your question. Can we secure it?

The candidate (your view). The shipped surface — endpoints, flows, identities, data at rest, data in motion.

What you produce. A threat model covering every STRIDE letter, written into the decision document.

Verdict vocabulary — per surface:
  - S (Spoofing)        — identity, auth, replay. Harden or named-and-deferred (a finding the team acknowledges with a named owner).
  - T (Tampering)       — input integrity, signing, audit. Harden or named-and-deferred (a finding the team acknowledges with a named owner).
  - R (Repudiation)     — auditability, signed events. Harden or named-and-deferred (a finding the team acknowledges with a named owner).
  - I (Information)     — disclosure, exfil. Harden or named-and-deferred (a finding the team acknowledges with a named owner).
  - D (Denial of service) — rate limits, headroom. Harden or named-and-deferred (a finding the team acknowledges with a named owner).
  - E (Elevation)       — privilege escalation, scope. Harden or named-and-deferred (a finding the team acknowledges with a named owner).

Your gate. every surface has a verdict; a bare attack vector with no hardening row and no named-and-deferred fails.

Skip condition. Skip when the artifact is throwaway or static docs.

Fail-with-the-fix. Every FAIL prints violation + the fix + where.
```

## Notes

- A hardening row carries the specific ticket or runbook paragraph.
- A named-and-deferred finding carries a named owner.
- A letter without a verdict fails the gate.

## Provenance

Theorm of STRIDE is industry-standard. Harbor invokes it as probe 3 of the candidate's grill.
