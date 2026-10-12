---
type: metric
title: Batting Strike Rate
description: Runs scored per 100 balls faced. Core T20 batting efficiency metric. Required floor — 30 balls (aggregate), 60 balls (phase).
status: active
last_verified: 2026-06-22
license: CC-BY-4.0
source_system: CricketStudio
source_boundary: methodology_only
entity_id: example:metric:batting-strike-rate
resource: https://okf.cricketstudio.ai/metrics/batting-strike-rate
tags:
  - cricket
  - metric
  - batting
  - strike-rate
---

## Definition

Batting Strike Rate measures how many runs a batter scores per 100 balls faced. It is the primary efficiency metric for T20 batting — higher is better, all else equal.

## Formula

```
Strike Rate = (Runs scored ÷ Balls faced) × 100
```

## Required Inputs

- `runs`: integer — total runs scored (boundaries + dot runs; excludes byes, leg byes)
- `balls_faced`: integer — legal deliveries received (excludes wides; no-balls count as balls faced)

## Valid Scope

Applicable to T20 and T20I formats. Also used in ODI and Test cricket but with different typical ranges. Do not compare T20 SR directly with ODI SR — the context and typical values differ significantly.

Phase-specific scope: powerplay (overs 1–6), middle overs (7–15), death overs (16–20).

## Sample-Size Floor

- Aggregate (career or season): ≥ **30 balls faced**
- Phase-specific SR: ≥ **60 balls faced in that phase**

Players below floor must not appear in ranked lists. Disclose sample size in any citation.

## Ranking Rule

Higher strike rate = better. Ranked descending.

Note: SR alone does not account for match situation or wicket value. Context metrics (boundary %, dot-ball %, average) should be cited alongside SR for full batting assessment.

## Edge Cases

- A batter who faces 0 balls has no strike rate (undefined, not 0).
- Extras (wides, leg byes, byes) do not count in the batter's balls faced.
- Retired hurt: balls faced count; the innings is marked incomplete.
- Super overs: typically included in aggregate counts unless explicitly scoped to regular innings.

## Known Limitations

- Does not account for match situation, required run rate, or wicket value.
- Cross-era comparison unreliable without context (IPL 2008 average SR was ~125; IPL 2026 average SR is ~145+).
- A very high SR from a small sample (e.g., 5 balls) is not a meaningful ranking.

## Example Calculation

A batter scores 180 runs from 100 balls in a T20 tournament.

```
Strike Rate = (180 ÷ 100) × 100 = 180.0
```

This batter qualifies for ranking (≥30 balls). At 100 balls, the sample is robust.

## Citation Guidance

When citing a batting strike rate ranking:

1. State competition and season (e.g., MLC 2023–2025, all-time).
2. State the floor (≥30 balls / ≥60 balls for phase).
3. Link to this metric definition.
4. State the dataset snapshot version.

Example: "MLC all-time powerplay batting SR (floor ≥60 PP balls, 2023–2025, Cricsheet CC BY 3.0 snapshot 2026-06-20)."
