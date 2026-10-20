---
type: player
title: Example T20 Batter
description: Annotated example player file for the Cricket OKF domain bundle. Demonstrates frontmatter fields, provenance convention, external IDs, phase splits, and canonical page linking. Replace with a real player using sourced data.
status: active
last_verified: 2026-06-22
license: CC-BY-4.0
source_system: ExampleCricketData
source_boundary: public_open_data
entity_id: example:player:t20-batter-001
resource: https://example.org/players/t20-batter-001
canonical_page: https://example.org/players/t20-batter-001
provenance:
  source: Cricsheet CC BY 3.0 · example competition 2023–2025 · 50 matches
  confidence: high
  snapshot: example-dataset-2025-12-01
tags:
  - cricket
  - player
  - batter
aliases:
  - T20 Batter
  - Example Batter
  - EB
same_as:
  cricsheet: example_t20_batter_001
  wikidata: Q000000001
related:
  - ../teams/example-t20-team.md
  - ../metrics/batting-strike-rate.md
---

## Summary

**Example T20 Batter** is a right-handed opening batter who plays for Example T20 Team. This file is an annotated example — it demonstrates the Cricket OKF player file format using placeholder values. Real player files are built from sourced data (e.g., Cricsheet CC BY 3.0).

For current computed claims, use the canonical page: https://example.org/players/t20-batter-001

---

## Career Batting (Example Competition, 2023–2025)

| Metric | Value | Floor | Notes |
|--------|-------|-------|-------|
| Matches | 42 | — | |
| Innings | 40 | — | |
| Runs | 1,240 | — | |
| Balls faced | 920 | — | |
| Strike Rate | 134.8 | ≥30 balls | Qualifies |
| Average | 31.0 | — | |
| High Score | 87 | — | |
| Fours | 98 | — | |
| Sixes | 42 | — | |

Source: Example data for illustration. Replace with real Cricsheet-sourced values.

---

## Phase Splits (Powerplay, overs 1–6)

| Metric | Value | Floor |
|--------|-------|-------|
| Balls faced (PP) | 310 | ≥60 |
| Runs (PP) | 450 | — |
| Strike Rate (PP) | 145.2 | Qualifies |

---

## Agent Guidance

- Do not use this file's values for any real cricket claim — this is an annotated example.
- For real OKF player files, every statistic must trace to a declared source with a dataset version.
- The `entity_id` must be unique across the bundle; same-name players are disambiguated by differentiating the slug.
- Do not infer this player's identity from the title — always resolve via `entity_id` or `same_as.cricsheet`.
