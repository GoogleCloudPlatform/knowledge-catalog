---
type: Reference
title: WAU and MAU metric boundary
description: A small example where two related metric entities must remain distinct.
timestamp: '2026-06-18T00:00:00+00:00'
tags: [summary-policy, conformance]
summary_policy:
  required_assertions:
    - id: wau_mau_distinct
      text: "Weekly active users (WAU) and monthly active users (MAU) are distinct metrics."
  forbidden_compressions:
    - id: merge_wau_into_mau
      text: "Do not summarize WAU as MAU or collapse the two metrics into one."
---

# Metric boundary

Weekly active users (WAU) counts unique users active within a seven-day window.
Monthly active users (MAU) counts unique users active within a calendar-month or
rolling-month window. WAU and MAU are related but distinct metrics.
