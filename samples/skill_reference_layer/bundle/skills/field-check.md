---
type: Skill
title: "Field Check"
description: "Use when the task is to verify connectivity to a remote endpoint — TCP / DNS / HTTP HEAD probe — and report a single go / no-go result with the latency envelope."
when_to_use:
  - "Test a service is reachable from a host before a deploy"
  - "Probe a peer service in a pre-flight check"
when_not_to_use:
  - "Diagnose slow paths — use a tracer-style skill"
  - "Validate payloads beyond liveness — use a contract-test skill"
tags: [network, probe, liveness]
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

# Field Check

## Doctrine

- **Probe, don't enumerate.** A connectivity check is one go / no-go, not a network map.
- **Latency envelope first.** A check that returns 200 after a 30s timeout is still a fail.

## Algorithm

1. Parse the endpoint URL — scheme, host, port, path.
2. Resolve DNS fresh. If unresolvable, emit `unreachable` and stop.
3. Open TCP to host:port. If connect exceeds the envelope, emit `unreachable`.
4. (HTTP only) Issue a HEAD with a tight timeout. Emit `no-go` on non-2xx.
5. Emit `go` with the recorded latency.

## Judge rubric

The skill emits one of:

- `go` — endpoint reachable within the latency envelope.
- `no-go` — non-2xx response or timeout on the application-layer probe.
- `unreachable` — DNS or TCP layer failure.

The gate that proves a run: `connect()` returned within the envelope; the self-test runs the skill against a known-failing endpoint and asserts the failure verdict.

## Skip conditions

- The endpoint is local or unix — `no surface applies`.
- The task explicitly demands a payload-level check — use a contract-test skill.

## Common mistakes

| Mistake | Reality |
|---|---|
| Treating any 2xx as success | A redirect to a 404 page is still a fail |
| Trusting the first byte | A TLS handshake that hangs is no-go even at byte one |
| Skipping DNS | /etc/hosts lying is a frequent foot-gun |

## Provenance

A standalone skill. No upstream fold.
