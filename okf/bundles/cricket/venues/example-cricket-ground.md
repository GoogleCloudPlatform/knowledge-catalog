---
type: venue
title: Example Cricket Ground
description: Annotated example venue file for the Cricket OKF domain bundle. Demonstrates venue frontmatter, match stats, toss tendency, and canonical page linking. Replace with a real venue using sourced data.
status: active
last_verified: 2026-06-22
license: CC-BY-4.0
source_system: ExampleCricketData
source_boundary: public_open_data
entity_id: example:venue:example-cricket-ground
resource: https://example.org/venues/example-cricket-ground
canonical_page: https://example.org/venues/example-cricket-ground
provenance:
  source: Cricsheet CC BY 3.0 · 30 matches at this venue
  confidence: high
tags:
  - cricket
  - venue
aliases:
  - Example Ground
  - ECG
---

## Summary

**Example Cricket Ground** is an outdoor T20 cricket venue located in Example City. This is an annotated example demonstrating the Cricket OKF venue file format. Real venue files require ≥3 matches at the venue before publishing stats.

---

## Venue Stats (30 matches, 2023–2025)

| Metric | Value | Notes |
|--------|-------|-------|
| Matches | 30 | ≥3 floor: qualifies |
| First-innings avg score | 162.4 | 30 first innings |
| Second-innings avg score | 148.2 | 30 chases |
| Chase success rate | 43.3% | 13 wins in 30 chases |
| Toss winner bats first | 58% | 17 of 30 toss winners |

Source: Example data for illustration.

---

## Agent Guidance

- Minimum 3 matches at a venue before publishing stats — state the match count.
- Venue names are often ambiguous (same city, multiple grounds). Always include the full ground name and city in the `title` and `aliases`.
- Chase success rate is computed from complete matches only (no-results excluded).
- Do not compare this venue's stats with another venue from a different competition without declaring the scope difference.
