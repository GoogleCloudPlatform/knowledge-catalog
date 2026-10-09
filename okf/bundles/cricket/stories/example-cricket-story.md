---
type: story
title: Example Cricket Story — The Toss Effect
description: Annotated example story file for the Cricket OKF domain bundle. Demonstrates the narrative layer format — hook, data, wow, limitations, and related concepts — backed by provenance. Replace with real sourced data.
status: active
last_verified: 2026-06-23
license: CC-BY-4.0
source_system: ExampleCricketData
source_boundary: derived_claims_only
entity_id: example:story:t20-toss-effect
canonical_page: https://example.org/stories/t20-toss-effect
resource: https://example.org/stories/t20-toss-effect
provenance:
  source: Cricsheet CC BY 3.0 · example T20 competition 2019–2025 · 500 matches
  confidence: high
  dataset_version: 2025-12-01
  notes: All figures derived from Cricsheet open data. No licensed feed data included. Replace with real dataset reference before publishing.
tags:
  - cricket
  - story
  - toss
  - T20
  - venue
related:
  - ../metrics/bowling-economy.md
  - ../spec/sample-size.md
  - ../venues/example-cricket-ground.md
  - ../dossier/example-agent-pattern.md
---

## The Question Nobody Asked

Does winning the toss actually matter in T20 cricket — or are teams just choosing what they'd already decided?

---

## What the Data Says

Across [N] matches in [Example T20 Competition] from [Year] to [Year]:

| Finding | Value | Sample |
|---------|-------|--------|
| Toss winners' win rate | [X]% | [N] matches |
| Bowl-first decisions | [X]% of toss wins | [N] decisions |
| First-innings average score | [X] | [N] innings |
| Second-innings average score | [X] | [N] innings |
| Chase success rate | [X]% | [N] chases |

At [Example Ground], the split is more pronounced: [X]% of toss winners chose to bowl first, but the first-innings average ([X]) exceeds the second-innings average ([X]).

Floor: Minimum [N] matches per venue before venue-level claims are cited.

Source: Cricsheet CC BY 3.0 · [Competition] [Years] · snapshot [Date]. Replace bracketed values with real figures before publishing.

---

## The Wow

Teams overwhelmingly choose to bowl first at [Example Ground] — but the team batting first scores more runs on average. The herd consensus and the data point in opposite directions.

---

## What It Doesn't Say

- This does not prove batting first always wins — pitch conditions vary match to match.
- Toss winners who bowl first and lose may still be making the right decision given information they had at toss time (pitch inspection, weather forecast, squad composition).
- A larger sample (≥30 matches per venue) is needed before venue-level claims are cited as reliable.
- This analysis covers [Competition] only — findings may not transfer to other formats or venues.

---

## How to Use This File Format

A `story` type file in Cricket OKF is a **provenance-backed cricket narrative**. It is not a raw data dump or a match report. It must:

1. **State a clear question** — the hook that frames the analysis.
2. **Show the data** — real numbers with source, scope, and sample size.
3. **State the wow** — the counterintuitive or surprising finding in plain English.
4. **Disclose limitations** — what the data doesn't say, can't say, or leaves open.
5. **Link related concepts** — metric definitions, venue files, dossier patterns.

The `source_boundary: derived_claims_only` flag signals that this file contains derived analysis, not raw feed data. The `provenance:` block is mandatory for all `story` type files.

---

## Agent Guidance

- Do not use the placeholder values in this file for any real cricket claim — this is an annotated example.
- When citing a real OKF story file, include: the story URL, the dataset version, the competition, the sample size, and the stated limitation.
- Do not cross-compare findings from different stories without declaring both datasets and their scope.
- If a user asks for a stat that appears in a story file but was not stated with a floor, do not infer it qualifies — check the methodology files.

---

## Related Concepts

- [Bowling Economy](../metrics/bowling-economy.md) — metric definition with formula, floor, and limitations
- [Sample-Size Doctrine](../spec/sample-size.md) — minimum data thresholds before claims are valid
- [Example Cricket Ground](../venues/example-cricket-ground.md) — venue entity with innings averages
- [Example Agent Pattern](../dossier/example-agent-pattern.md) — how agents should answer powerplay SR questions
