---
type: Experiment
title: Gradient boosting v2
description: Gradient-boosted trees with engineered features; current best cross-validation score.
tags:
- experiment
- gradient-boosting
- feature-engineering
timestamp: '2026-02-11T16:20:00+00:00'
---

Builds on the baseline by adding ratio and count-encoding features, trained with
gradient-boosted decision trees. Applies the leakage fix from the baseline
post-mortem.

# Setup

| Field | Value |
| --- | --- |
| Algorithm | Gradient-boosted trees (400 rounds, depth 6, lr 0.03) |
| Features | 11 raw + 9 engineered (ratios, count encodings) |
| Validation | 5-fold stratified cross-validation, seed 42 |
| Metric | ROC AUC |

# Result

| Split | ROC AUC |
| --- | --- |
| CV mean | 0.834 |
| CV std | 0.005 |

# Notes

Explicitly drops `row_id` per [target leakage via row id](/lessons/target_leakage_via_row_id.md).
The tuned artifact exported from this experiment is [gbdt tuned](/models/gbdt_tuned.md).

# Citations
- https://xgboost.readthedocs.io/en/stable/
