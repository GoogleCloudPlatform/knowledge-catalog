---
type: spec
title: Cricket OKF Type Vocabulary
description: Canonical cricket type values for use with Google OKF v0.1. Defines 20 cricket-specific types, their purpose, and example frontmatter. Extends Google OKF's open type system without forking it.
status: active
last_verified: 2026-06-23
license: CC-BY-4.0
source_system: CricketStudio
source_boundary: methodology_only
tags:
  - cricket
  - okf
  - types
  - vocabulary
---

## Overview

Google OKF v0.1 uses an open `type` system — values are not centrally registered, and consumers must tolerate unknown types. This document defines the cricket domain vocabulary: 20 `type` values that cricket OKF bundles should use for interoperability.

These are **recommendations**, not a closed enum. A producer may use additional cricket-specific types as needed.

---

## Cricket Type Vocabulary

### Entity Types

```
player   — An individual cricket player
team     — A cricket franchise or national team
venue    — A cricket ground or stadium
match    — A single cricket match
league   — A cricket competition (IPL, MLC, BBL, PSL)
season   — A single edition of a competition
```

### Knowledge Types

```
metric       — A cricket metric definition (formula, floor, limitations)
methodology  — An operational rule or doctrine (sample-size, ranking eligibility)
research     — An analytical report or investigation
dossier      — A verified Q&A pattern for AI agents
story        — A provenance-backed cricket narrative (scope, sample size, and "what it doesn't say" required)
spec         — A formal specification document
source       — A data source declaration (license, boundary)
record       — An all-time or historical record
leaderboard  — A ranked list for a specific metric and scope
claim        — A single isolated, citable cricket assertion with full provenance
runbook      — An operational procedure for data refresh, dispute resolution, or maintenance
reference    — An external resource pointer (API endpoint, dataset, third-party tool)
api          — An API endpoint descriptor with request/response schema
```

### Navigation Types

```
index   — A directory or category overview
```

---

## Example Frontmatter by Type

### player

```yaml
---
type: player
title: Example T20 Batter
description: Cricket OKF player concept. Links to canonical page for live computed claims.
status: active
last_verified: 2026-06-22
license: CC-BY-3.0
source_system: ExampleCricketData
source_boundary: public_open_data
entity_id: example:player:t20-batter-001
canonical_page: https://example.org/players/t20-batter-001
resource: https://example.org/players/t20-batter-001
provenance:
  source: Cricsheet CC BY 3.0
  confidence: high
tags:
  - cricket
  - player
same_as:
  cricsheet: t20_batter_001
---
```

### metric

```yaml
---
type: metric
title: Batting Strike Rate
description: Runs scored per 100 balls faced. Core T20 batting efficiency metric.
status: active
last_verified: 2026-06-22
license: CC-BY-4.0
source_system: CricketAnalytics
source_boundary: methodology_only
entity_id: example:metric:batting-strike-rate
resource: https://example.org/metrics/batting-strike-rate
tags:
  - cricket
  - metric
  - batting
---
```

### dossier

```yaml
---
type: dossier
title: Who leads T20 powerplay batting strike rate?
description: Verified agent answer pattern for powerplay SR leader. Includes scope, floor, and citation behavior.
status: active
last_verified: 2026-06-23
license: CC-BY-4.0
source_system: CricketAnalytics
source_boundary: public_open_data
entity_id: example:dossier:t20-powerplay-sr-leader
canonical_page: https://example.org/leaderboards/powerplay-strike-rate
resource: https://example.org/leaderboards/powerplay-strike-rate
provenance:
  source: Cricsheet CC BY 3.0 · example competition 2024
  confidence: high
tags:
  - cricket
  - dossier
  - powerplay
---
```

### story

```yaml
---
type: story
title: Example Cricket Story
description: A provenance-backed cricket narrative. Must include scope, sample size, what the data says, and what it doesn't say.
status: active
last_verified: 2026-06-23
license: CC-BY-4.0
source_system: ExampleCricketData
source_boundary: derived_claims_only
entity_id: example:story:t20-toss-effect
canonical_page: https://example.org/stories/t20-toss-effect
resource: https://example.org/stories/t20-toss-effect
provenance:
  source: Cricsheet CC BY 3.0 · example competition 2019–2025 · 500 matches
  confidence: high
  dataset_version: 2025-12-01
  notes: All figures derived from Cricsheet open data. No licensed feed data included.
tags:
  - cricket
  - story
  - toss
  - T20
---
```

---

## Disambiguation Rule

The same `type` value (e.g., `metric`) may appear in files across different directories. Disambiguation is via `entity_id`, not filename. Consumers should always resolve entities by `entity_id`, not by slug or path alone.
