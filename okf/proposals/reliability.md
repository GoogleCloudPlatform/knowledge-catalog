# Reliability (optional convention)

**Status:** Draft proposal, tracking [#151](https://github.com/GoogleCloudPlatform/knowledge-catalog/issues/151) and [#158](https://github.com/GoogleCloudPlatform/knowledge-catalog/issues/158). Not yet part of the SPEC; offered for discussion.

This document proposes one optional frontmatter key, `reliability`, under the existing extension allowance in SPEC §4.1 ("Producers MAY include any additional keys"). It standardizes only an agreed name and shape; it does not change the required surface. `type` remains the only required field, and a minimal producer ignores `reliability` entirely.

## 1. Motivation

A concept can be correctly signed (integrity) and correctly cited (groundedness) and still leave a consuming agent unable to tell a claim *verified against a live system* from one that merely *restates vendor documentation* from one that is *inferred*. A citation proves a claim is grounded; it does not grade the ground. For a retrieval agent that is tolerable. For an agent that **acts** on a real system, that grade is where damage is avoided.

This is the fourth trust axis, distinct from the three already in flight:

| Axis | "Trust that…" | Where it lives |
|---|---|---|
| Integrity | the bundle is from who it claims, unaltered | #140 |
| Safety | the content is data, not instructions | #58 §12 |
| Groundedness | a claim is linked to evidence | #92 / #94 |
| **Reliability** | **how much to believe the claim itself** | **this proposal, #151** |

## 2. The `reliability` key

`reliability` is an optional YAML mapping in a concept's frontmatter. It is a **maturity ladder, not a mandate**: a producer adopts only the tiers it can honestly populate.

### 2.1 Floor

- `confidence` (required within the object) — an ordinal band, one of `HIGH | MEDIUM | LOW | UNVERIFIED`. This is the interoperable surface consumers filter on.
- `basis` — how the claim was obtained, one of `live-source | partner-attested | vendor-doc | forecast | computed | inferred`, ordered most to least authoritative when sources disagree.

### 2.2 Corroboration tier

- `sources` — integer count of independent sources behind the claim.
- `verified` — boolean. See the honesty rules in §3.
- `score` — an optional `0..1` float, present **only** when actually computed from `signals`. Absent means "not computed", not "hidden".

### 2.3 Maintenance tier

- `conflict` — a first-class disagreement state, distinct from merely uncorroborated. While `disputed` is true, both `positions` are retained and a `resolution` records what the trust ordering selected without discarding the other side.
- `validity` — an applicability window (when or for which versions the claim holds), a separate clock from measurement recency, often version-keyed. Anonymous expiry (`valid_until`) lives here; **named** supersession is a typed cross-concept edge tracked separately in #158 / #148, not on this object.
- `freshness` — measurement recency (`as_of`, `state`).
- `signals` — the transparent inputs `confidence` and `score` are recomputed from (`signed`, `corroborated`, `fresh`).
- `assessed_at` and `lifecycle` — for producers that persist a grade history. A recompute-per-read producer sets `assessed_at` and omits `lifecycle`; a stored-ladder producer logs transitions in `lifecycle`.

## 3. Honesty rules

These keep the axis trustworthy rather than decorative:

1. **Signed is not verified.** `signals.signed` proves integrity only and MUST NOT be coupled to `verified`.
2. `verified: true` MUST assert `sources >= 2`.
3. An `UNVERIFIED` band, or a disputed conflict, MUST NOT be `verified`.
4. When `score` is present it MUST be recomputable from `signals` and ordinally coherent with `confidence`. Note the band is **not** a pure re-banding of the score: it also reflects a corroboration ceiling, so a single-source reading caps at `MEDIUM` even when its raw score is high.
5. A disputed conflict caps `confidence` at `MEDIUM` (`HIGH` excluded). An open disagreement is a corroboration failure, so the claim cannot be `HIGH`; the position the trust ordering selects MAY still carry up to `MEDIUM` (a conservative producer MAY floor to `LOW`), while `disputed: true` stays flagged. This is the same corroboration ceiling as rule 4, applied to disputes: it gives a consumer both the dispute flag and a usable graded answer rather than discarding the prevailing reading.

## 4. Examples

A live, single-source concept:

```markdown
---
type: Live Metric
title: US CPI inflation (annual)
description: Headline year-over-year CPI-U inflation for the United States.
resource: https://dynamicfeed.ai/v1/facts?tool=us_economy&indicator=cpi
timestamp: 2026-06-29T00:00:00Z
reliability:
  confidence: MEDIUM
  basis: live-source
  score: 0.8
  sources: 1
  verified: false
  freshness: { as_of: 2026-06-29T00:00:00Z, state: fresh }
  signals: { signed: true, corroborated: false, fresh: true }
  assessed_at: 2026-06-29T00:00:00Z
---

# Value

4.25% over the 12 months ending 2026-05 (BLS, signed envelope).
```

A conflict case, where independent sources disagree on the same reading:

```markdown
---
type: Live Metric
title: PM2.5, station 118
reliability:
  confidence: LOW
  basis: live-source
  sources: 2
  verified: false
  conflict:
    disputed: true
    positions:
      - { statement: "PM2.5 = 42 ug/m3", basis: live-source, source: "Sensor network A, observed 2026-06-29T10:50Z" }
      - { statement: "PM2.5 = 11 ug/m3", basis: vendor-doc, source: "Regulatory daily summary, prior-day average" }
    resolution: "live-source prevails under the trust ordering; both positions retained"
  validity: { keyed_by: date, valid_from: 2026-06-29, valid_until: null }
  freshness: { as_of: 2026-06-29T10:50:00Z, state: fresh }
  signals: { signed: true, corroborated: false, fresh: true }
---
```

## 5. Validation (optional)

Consistent with OKF's stance that it *references* schemas rather than subsuming them (SPEC, Non-goals), an optional JSON Schema (draft 2020-12) for the `reliability` object is published at:

- Schema: <https://dynamicfeed.ai/schemas/okf-reliability-v1.json>
- Worked example bundle: <https://dynamicfeed.ai/schemas/okf-reliability-examples.json>

Producers MAY validate against it. Per SPEC §4.1, consumers MUST NOT reject a document solely for omitting `reliability` or for carrying keys beyond those defined here. The schema encodes the §3 honesty rules as constraints, and has been validated against three independent production shapes (a live-data layer, a multi-version corpus, and a multi-domain human-authored KB).
