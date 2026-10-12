---
type: Model
title: GBDT tuned
description: Tuned gradient-boosted tree model exported from experiment gradient-boosting v2.
resource: https://example.com/artifacts/gbdt_tuned_2026-02-11.pkl
tags:
- model
- gradient-boosting
timestamp: '2026-02-11T17:05:00+00:00'
---

The serialized model artifact selected for submission. Produced by
[gradient boosting v2](/experiments/gradient_boosting_v2.md).

# Interface

| Property | Value |
| --- | --- |
| Format | pickled scikit-learn pipeline |
| Input | 20 features (see the source experiment) |
| Output | Probability in `[0, 1]` |

# Notes

Scored on the public leaderboard by
[leaderboard submission 2026-02-18](/submissions/leaderboard_2026_02_18.md).

# Citations
- https://scikit-learn.org/stable/model_persistence.html
