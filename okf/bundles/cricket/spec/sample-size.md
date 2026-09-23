---
type: spec
title: Cricket OKF Sample-Size Doctrine
description: Minimum data thresholds before a cricket claim is valid for ranking or comparison. Defines floors for batting, bowling, phase, H2H, and venue. Essential for AI agents — never rank below floor.
status: active
last_verified: 2026-06-22
license: CC-BY-4.0
source_system: CricketStudio
source_boundary: methodology_only
tags:
  - cricket
  - okf
  - sample-size
  - methodology
---

## Why Floors Exist

A batter who scores 50 from 10 balls has a strike rate of 500. A bowler who takes 3 wickets from 12 balls has an economy of 15. Neither of these is meaningful as a ranking — both are small-sample artefacts.

Sample-size floors protect the credibility of ranked claims.

---

## Standard Cricket OKF Sample-Size Floors

| Context | Floor |
|---------|-------|
| Batting aggregate (career or season) | ≥ 30 balls faced |
| Batting — powerplay phase (overs 1–6) | ≥ 60 balls faced in phase |
| Batting — middle overs phase (overs 7–15) | ≥ 60 balls faced in phase |
| Batting — death overs phase (overs 16–20) | ≥ 60 balls faced in phase |
| Bowling aggregate (career or season) | ≥ 15 balls bowled |
| Bowling — any phase | ≥ 30 balls bowled in phase |
| Head-to-head (batter vs bowler) | ≥ 5 deliveries faced |
| Venue stat (chase rate, toss tendency) | ≥ 3 matches at venue |

---

## How to Declare a Floor

In metric files:

```markdown
## Sample-Size Floor

Minimum 30 balls faced (aggregate). For phase-specific strike rate: minimum 60 balls in that phase.
Players below floor must not appear in ranked lists.
```

In leaderboard files (frontmatter):

```yaml
provenance:
  notes: "Floor: ≥30 powerplay balls faced."
```

---

## What an Agent Must Do

1. Always check the declared floor before citing a ranked claim.
2. Never present a sub-floor player as a ranked result.
3. If a player is below floor, say "insufficient data for ranking" — do not invent a position.
4. When citing any ranking, reproduce the floor in the citation.

---

## Cross-Competition Floor Rule

When comparing players across competitions, the floor applies **per competition**. Do not aggregate balls across IPL and MLC to meet a floor for either.
