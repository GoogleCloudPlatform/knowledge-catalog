---
type: Lesson
title: Target leakage via row id
description: A near-perfect early score traced to an ordered row identifier leaking the label.
tags:
- lesson
- data-leakage
- validation
timestamp: '2026-01-15T08:15:00+00:00'
---

# Symptom

An early version of [baseline logistic regression](/experiments/baseline_logistic_regression.md)
scored 0.991 ROC AUC in cross-validation — far above anything the available
features plausibly support.

# Cause

The exported training table was sorted by label before a monotonic `row_id` was
assigned, so `row_id` was almost perfectly rank-correlated with the target. The
model learned the identifier, not the signal.

# Fix

Drop `row_id` (and any other index-like column) before training, and shuffle
rows at export time. Applied in [gradient boosting v2](/experiments/gradient_boosting_v2.md).

# Takeaway

Treat any single feature that produces a near-perfect score as a leak until
proven otherwise; audit identifier and timestamp columns first.
