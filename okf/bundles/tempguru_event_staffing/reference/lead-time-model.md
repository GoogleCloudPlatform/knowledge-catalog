---
type: "Heuristic"
title: "Lead-Time Model"
description: "How TempGuru computes availability guidance from market tier and days until the event."
tags:
  - "reference"
  - "lead-time"
  - "availability"
timestamp: "2026-06-13T00:00:00Z"
---

# Lead-Time Model

`check_availability` returns **guidance, not a reservation.** It compares the days
until the event against a typical lead time for the city's [market tier](../pricing/market-tiers.md).

## Typical lead time by tier

| Tier | Typical lead time |
|---|---|
| Hub | 48 hours |
| Mid | 72 hours |
| Small | 168 hours (1 week) |

## Recommendation label

Given `hoursUntil = daysUntilEvent × 24` and the tier's `leadHours`:

- **yes**, `hoursUntil ≥ leadHours × 2` (comfortable runway)
- **tight**, `hoursUntil ≥ leadHours`
- **rush**, `hoursUntil ≥ 24`
- **very-rush**, less than 24 hours out

Small markets need more runway than hubs because the active roster is thinner in
tertiary cities. These are guidance bands, not hard cutoffs, **never promise
availability.** See [plan staffing](../workflows/plan-staffing.md).
