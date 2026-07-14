---
type: Collection
title: Acme Retail
description: OKF v0.2 knowledge bundle for Acme Retail's BigQuery data warehouse. Definitions, sanctioned computations, and trust signals for finance and product metrics.
resource: https://console.cloud.google.com/bigquery?p=acme
tags: [retail, ecommerce, finance, bigquery]
okf_version: "0.2"
generated: { by: reference_agent/gemini-2.5-pro, at: 2026-06-30T14:00:00Z }
verified:
  - { by: human:kliu@acme, at: 2026-07-01T16:00:00Z }
status: stable
---

# Acme Retail

Shared knowledge for AI-assisted analytics over Acme Retail's BigQuery data warehouse. Every finance-critical concept is verified by `human:jsmith@acme` (VP Finance); machine-generated concepts by `reference_agent/gemini-2.5-pro` are re-verified against source policies as they change.

## Tables

- [`orders`](/tables/orders.md) — one row per completed customer order, all channels

## Metrics

- [`revenue`](/metrics/revenue.md) — recognized revenue per Acme's FY2026 policy
- [`gross-margin`](/metrics/gross-margin.md) — gross margin per Acme's FY2026 Cost Allocation Standard
- [`gross-margin-legacy`](/metrics/gross-margin-legacy.md) — **deprecated**, kept for historical reproducibility

## Attested computations

- [`revenue-ytd`](/computations/revenue-ytd.md) — sanctioned SQL for revenue, `runtime: bigquery`
- [`gross-margin-period`](/computations/gross-margin-period.md) — sanctioned SQL for gross margin, `runtime: bigquery`

## Policies

- [`revenue-recognition`](/policies/revenue-recognition.md) — when a customer order becomes revenue (FY2026)
- [`margin-standard`](/policies/margin-standard.md) — COGS composition and gross-margin formula (FY2026)

## Skills

- [`run-on-bq`](/skills/run-on-bq.md) — executor for Attested Computations with `runtime: bigquery`

## Attesters

- [`sql_equality.py`](/attesters/sql_equality.py) — deterministic verification of BigQuery receipts against sanctioned SQL

## Lifecycle notes

- **Revenue** and **gross-margin** carry `stale_after: 2026-12-31` because Finance re-approves both underlying policies annually.
- **`gross-margin-legacy`** is `status: deprecated`. New work uses `gross-margin`.
- See [`log.md`](/log.md) for change history.
