---
type: spec
title: Cricket OKF Provenance Convention
description: How to declare source, boundary, confidence, and freshness in a cricket OKF file. Google OKF v0.1 has no provenance fields — this convention adds them for cricket data trust and AI-safe citation.
status: active
last_verified: 2026-06-22
license: CC-BY-4.0
source_system: CricketStudio
source_boundary: methodology_only
tags:
  - cricket
  - okf
  - provenance
  - licensing
---

## Why Cricket OKF Needs Provenance

Google OKF v0.1 is intentionally minimal — one required field (`type`) and five recommended fields. For cricket data, this is not enough.

Cricket claims are only trustworthy when they include:
- **Source** — which dataset and license
- **Boundary** — what redistribution is permitted
- **Confidence** — how reliable the data is
- **Freshness** — when it was last verified

Without these, an AI agent cannot safely cite a claim, a journalist cannot publish it, and a developer cannot trust it.

---

## Provenance Fields

### `provenance` block (required for data-bearing files)

```yaml
provenance:
  source: Cricsheet CC BY 3.0 · example competition 2024 · 50 matches
  confidence: high        # high | medium | low
  snapshot: example-dataset-2024-06-01   # optional
  notes: Season 2024 only — earlier seasons not included.  # optional
```

### `source_boundary` (required for all files)

Declares the redistribution envelope:

| Value | Meaning |
|-------|---------|
| `public_open_data` | From a publicly licensed open source (e.g., Cricsheet CC BY 3.0). Redistribution with attribution permitted. |
| `derived_claims_only` | Derived from a licensed feed. Raw feed not redistributed; derived claims and links only. |
| `methodology_only` | Formulas, rules, spec — no cricket data. |
| `manual_curated_knowledge` | Curated from public knowledge; no raw data redistribution. |

### `last_verified` / `timestamp`

ISO-8601 date when the content was last verified. Both field names are accepted:

```yaml
last_verified: 2026-06-22
timestamp: 2026-06-22     # Google OKF v0.1 recommended name
```

### `license`

SPDX identifier or plain string:

```yaml
license: CC-BY-4.0        # for methodology, spec, curated content
license: CC-BY-3.0        # for Cricsheet-derived content
```

---

## Decision Rule for source_boundary

```
Data from Cricsheet?                    → public_open_data
Data from a licensed third-party feed?  → derived_claims_only
Formulas / methodology / spec?          → methodology_only
Curated from public knowledge?          → manual_curated_knowledge
```

---

## Non-Negotiables

- Never declare `public_open_data` for data from a licensed feed.
- Never omit `last_verified` from a data-bearing file.
- Never cite generated prose as source evidence.
- When uncertain about confidence, use `medium`, not `high`.
