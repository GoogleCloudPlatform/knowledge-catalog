---
type: team
title: Example T20 Team
description: Annotated example team file for the Cricket OKF domain bundle. Demonstrates team frontmatter, season records, head-to-head structure, and canonical page linking. Replace with a real team using sourced data.
status: active
last_verified: 2026-06-22
license: CC-BY-4.0
source_system: ExampleCricketData
source_boundary: public_open_data
entity_id: example:team:t20-team-001
resource: https://example.org/teams/t20-team-001
canonical_page: https://example.org/teams/t20-team-001
provenance:
  source: Cricsheet CC BY 3.0 · example competition 2023–2025
  confidence: high
tags:
  - cricket
  - team
aliases:
  - ET Team
  - Example Team
related:
  - ../players/example-t20-batter.md
---

## Summary

**Example T20 Team** competes in the Example T20 Competition (ETC). This is an annotated example demonstrating the Cricket OKF team file format. Real team files are built from sourced match results.

For current computed claims, use the canonical page.

---

## All-Time Record (Example Competition, 2023–2025)

| Season | M | W | L | NR | Win % |
|--------|---|---|---|----|-------|
| 2023 | 8 | 5 | 3 | 0 | 62.5% |
| 2024 | 8 | 6 | 2 | 0 | 75.0% |
| 2025 | 10 | 7 | 3 | 0 | 70.0% |
| **All-time** | **26** | **18** | **8** | **0** | **69.2%** |

Source: Example data for illustration. Replace with real Cricsheet-sourced match results.

---

## Agent Guidance

- Do not cite this file's values for any real cricket claim.
- For real OKF team files, every record must trace to declared match results with a dataset version.
- Team names change over time — use `aliases` for historical names; do not create a separate file.
- Season-specific records belong in `season` files; this file holds the all-time team record.
