---
type: metric
title: Death Overs Economy
description: Bowling economy rate in the final overs of a T20 innings (overs 17–20, or 16–20). Phase-specific metric — floor is 30 death balls bowled. Higher-stakes phase with typically elevated economy across all bowlers.
status: active
last_verified: 2026-06-22
license: CC-BY-4.0
source_system: CricketStudio
source_boundary: methodology_only
entity_id: example:metric:death-overs-economy
resource: https://okf.cricketstudio.ai/metrics/death-overs-economy
tags:
  - cricket
  - metric
  - bowling
  - death-overs
  - phase
---

## Definition

Death Overs Economy measures a bowler's runs conceded per over during the death-overs phase of a T20 innings. The death phase is the highest-pressure phase — batters take maximum risk and typical economy rates are elevated across all bowlers.

## Phase Definition

- **Death overs:** Overs 17–20 of a T20 innings (some implementations use overs 16–20)
- CricketStudio OKF convention: **overs 16–20** (the final 5 overs)
- Always state which phase definition is used when citing this metric

## Formula

```
Death Economy = (Runs conceded in death overs ÷ Balls bowled in death overs) × 6
```

## Required Inputs

- `death_runs_conceded`: integer — runs conceded in the death phase only
- `death_balls_bowled`: integer — legal balls bowled in the death phase only

## Valid Scope

T20 and T20I formats only. Not applicable to ODI or Test cricket (no fixed death phase in longer formats).

## Sample-Size Floor

- Phase-specific: ≥ **30 balls bowled in death overs** (= 5 overs)
- This is a higher floor than the aggregate bowling economy (≥15 balls) because phase stats are more variable and need more data to stabilize.

## Ranking Rule

Lower economy = better. Ranked ascending within the death phase.

Do not directly compare death-over economy with powerplay economy or full-innings economy — different phases have structurally different typical values.

## Edge Cases

- A bowler who bowls only 1 death over in an entire season has no rankable death economy.
- Super overs are not death overs — they are separate innings.
- If a match is rain-affected and overs 17–20 are not bowled, those balls do not contribute.

## Known Limitations

- Economy alone does not capture wicket-taking ability. A death bowler with economy 9.5 and 15 wickets may be more valuable than one at 8.0 and 3 wickets.
- Match situation affects death economy significantly — defending 220 vs. 150 produces different bowler incentives and batter aggression.
- Small samples are especially misleading in death overs — always apply the ≥30 ball floor.

## Example Calculation

A bowler concedes 72 runs from 42 death-over balls across a season:

```
Death Economy = (72 ÷ 42) × 6 = 10.3 RPO
```

42 balls = 7 overs. Qualifies for ranking (≥30 balls).

## Citation Guidance

When citing a death-overs economy ranking:

1. State the phase definition used: overs 16–20 or 17–20.
2. State competition and season.
3. State the floor: ≥30 death balls bowled.
4. Link to this metric definition.
5. Note that economy in this phase is typically higher than full-innings economy.

Example: "MLC all-time death-overs economy (overs 16–20, floor ≥30 death balls, 2023–2025, Cricsheet CC BY 3.0 snapshot 2026-06-20)."
