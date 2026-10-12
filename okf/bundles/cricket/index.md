---
type: index
title: Cricket Domain Bundle for Google OKF
description: A cricket domain example bundle for Google Open Knowledge Format (OKF) v0.1. Demonstrates type vocabulary, provenance convention, sample-size doctrine, metric definitions, entity files, and agent Q&A patterns for cricket knowledge.
status: active
last_verified: 2026-06-22
license: CC-BY-4.0
source_system: CricketStudio
source_boundary: methodology_only
tags:
  - cricket
  - okf
  - domain-example
  - google-okf
---

## What Is This?

This is a cricket domain example bundle for [Google OKF v0.1](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md).

Cricket is one of the world's most data-rich sports, with complex metrics (batting strike rate, bowling economy, death-overs phase splits), multi-format competitions (T20, ODI, Test), and 150+ years of records. It is a strong test case for structured knowledge representation.

This bundle shows how the open `type` field, extended frontmatter, and a domain provenance convention can be used to make cricket knowledge portable, citable, and agent-readable.

---

## Cricket OKF Type Vocabulary

This bundle uses 15 cricket-specific `type` values:

| Type | Description |
|------|-------------|
| `player` | An individual cricket player |
| `team` | A cricket franchise or national team |
| `venue` | A cricket ground or stadium |
| `match` | A single cricket match |
| `league` | A cricket competition (IPL, MLC, BBL) |
| `season` | A single edition of a competition |
| `metric` | A cricket metric definition |
| `methodology` | An operational rule or doctrine |
| `research` | An analytical report |
| `dossier` | A verified Q&A pattern for AI agents |
| `record` | An all-time or historical record |
| `leaderboard` | A ranked list for a specific metric |
| `source` | A data source declaration |
| `index` | A directory or category index |
| `spec` | A formal specification document |

See [spec/types.md](./spec/types.md) for definitions and example frontmatter for each type.

---

## Key Domain Conventions

### Provenance

Cricket data comes from multiple sources with different licenses. Every data-bearing file declares `source_boundary`:

- `public_open_data` — Cricsheet CC BY 3.0 (ball-by-ball open data)
- `derived_claims_only` — licensed feed derived claims
- `methodology_only` — formulas and rules, no data

See [spec/provenance.md](./spec/provenance.md).

### Sample-Size Floors

Cricket rankings are meaningless below minimum data thresholds. This bundle defines:

- ≥30 balls faced (batting aggregate)
- ≥60 balls faced (phase stats: powerplay/middle/death)
- ≥15 balls bowled (bowling aggregate)
- ≥5 deliveries (head-to-head)
- ≥3 matches (venue stats)

See [spec/sample-size.md](./spec/sample-size.md).

### Metric Files

Every metric has a canonical definition file with: formula, required inputs, valid scope, sample-size floor, ranking rule, edge cases, limitations, example calculation, and citation guidance.

See [metrics/batting-strike-rate.md](./metrics/batting-strike-rate.md).

---

## Live Implementation

Full reference implementation: **https://okf.cricketstudio.ai**
GitHub: https://github.com/i-m-arul/cricketstudio-okf
