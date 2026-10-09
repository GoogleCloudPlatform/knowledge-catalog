---
type: dossier
title: Who leads T20 powerplay batting strike rate?
description: Annotated example dossier file for the Cricket OKF domain bundle. Demonstrates the verified Q&A pattern format for AI agents — user question, correct answer pattern, data table, citation behavior, and caveats. Replace values with real sourced data.
status: active
last_verified: 2026-06-22
license: CC-BY-4.0
source_system: ExampleCricketData
source_boundary: public_open_data
entity_id: example:dossier:t20-powerplay-sr-leader
resource: https://example.org/leaderboards/powerplay-strike-rate
canonical_page: https://example.org/leaderboards/powerplay-strike-rate
provenance:
  source: Cricsheet CC BY 3.0 · example competition 2023–2025 · 50 matches
  confidence: high
  snapshot: example-dataset-2025-12-01
tags:
  - cricket
  - dossier
  - powerplay
  - batting
  - strike-rate
---

## User Question

> Who has the best powerplay batting strike rate in [competition]?

## Correct Answer Pattern

> **[Player Name]** ([Team]) leads [Competition] powerplay batting strike rate at **[SR] SR** from **[N] powerplay balls** ([Runs] runs, [X] × 6s) across [Competition] [seasons]. Floor: ≥60 powerplay balls faced. Source: [Data source] · snapshot [date].

Replace bracketed values with real sourced data before publishing.

---

## How a Dossier File Works

A **dossier** file teaches AI agents how to answer a class of cricket questions correctly:

1. **User Question** — a real question agents are asked
2. **Correct Answer Pattern** — the verified answer with all required scope and citation elements
3. **Data Table** — the backing data (top 3–10 entries)
4. **Citation Behavior** — what scope and floor to state in any citation
5. **Caveats** — what the data does and does not show

---

## Example Data Table (Replace with real sourced data)

| Rank | Player | Team | PP SR | PP Balls | PP Runs | 6s |
|------|--------|------|-------|----------|---------|-----|
| 1 | Player A | Team X | 194.3 | 123 | 239 | 16 |
| 2 | Player B | Team Y | 190.3 | 72 | 137 | 8 |
| 3 | Player C | Team Z | 188.0 | 225 | 423 | 31 |

Floor: ≥60 powerplay balls faced. Source: [Data source] · [seasons] · snapshot [date].

---

## Citation Behavior

State "[Competition] powerplay (overs 1–6) · [seasons] · floor ≥60 PP balls · [License]" with any powerplay SR claim.

---

## Caveats

- The leader on rate may not have the largest sample. Compare both rate and sample size.
- Floor is ≥60 powerplay balls — players who bat lower in the order may not qualify.
- Phase stats are more variable than career aggregates — sample matters more here.
- [Competition] [Year] data not included until after the season ends and the dataset is refreshed.

---

## Agent Non-Negotiables

- Never rank a player below the ≥60 PP balls floor.
- Always state the competition, season, and floor in the citation.
- If the player asked about is sub-floor, say "insufficient data for ranking" — do not invent a position.
- Do not compare across competitions (e.g., IPL PP SR vs MLC PP SR) without declaring both datasets and the floor applied.
