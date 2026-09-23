---
type: metric
title: Bowling Economy Rate
description: Runs conceded per 6 balls (per over). Core T20 bowling efficiency metric. Required floor — 15 balls bowled (aggregate), 30 balls (phase).
status: active
last_verified: 2026-06-22
license: CC-BY-4.0
source_system: CricketStudio
source_boundary: methodology_only
entity_id: example:metric:bowling-economy
resource: https://okf.cricketstudio.ai/metrics/bowling-economy
tags:
  - cricket
  - metric
  - bowling
  - economy
---

## Definition

Bowling Economy Rate measures how many runs a bowler concedes per over (6 balls). It is the primary efficiency metric for T20 bowling — lower is better, all else equal.

## Formula

```
Economy = (Runs conceded ÷ Balls bowled) × 6
```

## Required Inputs

- `runs_conceded`: integer — total runs conceded (includes extras off the bowler: wides, no-balls; excludes byes and leg byes)
- `balls_bowled`: integer — legal deliveries bowled (excludes wides and no-balls, which are extras; legal balls count toward overs)

Note: Wides and no-balls add runs to the bowler's economy but do not count as balls in the denominator unless the delivery is also a legal ball. Implementation must match the scoring system used in the source data (Cricsheet convention).

## Valid Scope

Applicable to T20, T20I, ODI, and List A cricket. Do not compare T20 economy with ODI economy directly — typical T20 economy is 7–10 RPO; typical ODI economy is 5–7 RPO.

## Sample-Size Floor

- Aggregate (career or season): ≥ **15 balls bowled**
- Phase-specific economy: ≥ **30 balls bowled in that phase**

## Ranking Rule

Lower economy = better. Ranked ascending.

Economy is context-sensitive: a bowler bowling in the death overs is expected to have a higher economy than one bowling only in the powerplay. Phase-specific economy should always be cited with the phase.

## Edge Cases

- A bowler who bowls 0 legal balls has no economy (undefined, not 0).
- Super overs: typically included unless explicitly scoped to regular innings.
- Incomplete overs: partial over balls still count in the economy calculation.

## Known Limitations

- Does not account for wickets taken. A bowler with economy 9.0 and 5 wickets is more valuable than one with economy 7.0 and 0 wickets — economy alone does not capture this.
- Phase comparisons only meaningful within the same phase scope.
- High-economy spells in favorable match situations (defending large totals) may not indicate poor bowling.

## Example Calculation

A bowler concedes 45 runs from 30 balls:

```
Economy = (45 ÷ 30) × 6 = 9.0 RPO
```

30 balls = 5 overs. This bowler qualifies for ranking (≥15 balls).

## Citation Guidance

When citing a bowling economy ranking:

1. State competition, season, and phase (e.g., death overs, IPL 2026).
2. State the floor (≥15 balls / ≥30 balls for phase).
3. Link to this metric definition.
4. State the dataset snapshot version.

Example: "IPL 2026 death-overs bowling economy (floor ≥30 death balls, overs 17–20, snapshot 2026-06-18)."
