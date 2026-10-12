---
type: Experiment
title: Baseline logistic regression
description: First end-to-end baseline establishing the validation protocol and a reference score.
tags:
- experiment
- baseline
- logistic-regression
timestamp: '2026-01-14T09:00:00+00:00'
---

A minimal end-to-end run to lock the validation protocol before investing in
feature engineering. Establishes the reference score every later experiment is
compared against.

# Setup

| Field | Value |
| --- | --- |
| Algorithm | Logistic regression (L2, `C=1.0`) |
| Features | 11 raw numeric columns, standardized |
| Validation | 5-fold stratified cross-validation, seed 42 |
| Metric | ROC AUC |

# Result

| Split | ROC AUC |
| --- | --- |
| CV mean | 0.782 |
| CV std | 0.006 |

# Notes

An early version of this experiment scored a suspiciously high 0.991; that run
is written up in [target leakage via row id](/lessons/target_leakage_via_row_id.md).
Superseded as current best by [gradient boosting v2](/experiments/gradient_boosting_v2.md).

# Citations
- https://scikit-learn.org/stable/modules/linear_model.html#logistic-regression
