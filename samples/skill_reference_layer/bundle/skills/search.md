---
type: Skill
title: "Search"
description: "Use when a question needs the internet — a market, a library, a competitor, a how-to, an adoption surface, any claim that must be checked against the world before it locks — and the answer must be on an evidence ledger, not on a search-results list."
when_to_use:
  - "Validate a vendor claim against public material"
  - "Find existing libraries in a domain before designing one"
  - "Compare two market offerings with their public sources"
when_not_to_use:
  - "Read a single URL the user already has"
tags: [research, evidence]
status: stable
generated: { by: human:harbor-ops, at: 2026-08-18 }
verified:
  - { by: process:harbor-bundle-parse, at: 2026-08-18 }
  - { by: human:harbor-ops, at: 2026-08-18 }
sources:
  - id: harbor-decisions
    resource: ../decisions.md
    title: "Harbor Skills decisions (the D-NNN decision record)"
  - id: okf-spec-5
    resource: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
    title: "OKF v0.2 §5 (provenance, trust, lifecycle)"
---

# Search

## Doctrine

- A claim is its source and quote, not its paraphrase. The evidence ledger keeps verbatim quotations.
- A claim without a source is a guess wearing confidence.
- A contradiction is a finding, not a problem. Two sources disagreeing is the most valuable output.

## Algorithm

0. If the question does not apply, emit `no surface applies - skipping` and stop. Specific to this skill:
   - The question does not need external material — pure refactor of own code.

1. Shape the question. One sentence; what would count as an answer?
2. Federated search. Keyless engines in turn: each engine can be unavailable, an error is a finding not a retry trigger.
3. Targeted scrape. The primary source, not the summary.
4. Evidence ledger. For each claim you will emit: source URL + verbatim quote + confidence class.
5. Brief synthesis. Per claim: SUPPORTED / CONTRADICTED / UNVERIFIED, plus gaps.

## Judge rubric

- `SUPPORTED` — sources agree.
- `CONTRADICTED` — sources disagree (name both sides).
- `UNVERIFIED` — no reliable source (name the gap).


## Common mistakes

| Mistake | Reality |
|---|---|
| Research as reading | A pass that produces no evidence file is a conversation, not research |
| Trusting the aggregator | AI overviews are leads, not evidence — the origin is the source |
| Re-running the search | One pass, then harvest — a second identical query is tool thrash |

## Provenance

Standalone skill. The skills mount a federated-search engine inventory as opt-in defaults; this skill lists them only by capability, not by name.
