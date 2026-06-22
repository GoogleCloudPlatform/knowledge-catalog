---
type: "Dataset Schema"
title: "Data Schemas"
description: "The shape of the underlying TempGuru datasets that back this bundle and the live tools."
data_version: "1.0.0"
tags:
  - "reference"
  - "schema"
  - "data"
timestamp: "2026-06-13T00:00:00Z"
---

# Data Schemas

This bundle and the live tools are generated from these canonical datasets
(`content/mcp-data/`, version 1.0.0, updated 2026-06-13).

## City `{ slug, name, state, state_abbr, country, tier }`

`tier` is one of `hub` | `mid` | `small`. 345 cities total.

## Role `{ slug, name, description, skill_tier, typical_shift_length_hours }`

`skill_tier` is 1–5. 11 roles.

## Role pricing `{ [role_slug]: { small, mid, hub } }` (published rate card)

Each tier is a `{ low, high }` band in USD/hour, TempGuru's published per-role bill
rate (the [rate card](../pricing/rate-matrix.md)). The per-city rate card below is
the measured benchmark behind the [Rate Index](../rate-index.md).

## State compliance `{ [abbr]: { name, min_wage, overtime_weekly, overtime_daily, unique_rules[] } }`

`overtime_daily` is `null` unless the state applies daily overtime. 51 jurisdictions.

## Per-city rate card `{ tier, name, event_staff, ushers, crowd, asst_lead, team_lead, brand_amb, overall, avg_staff }`

Each role key is a `[low, high]` pair in USD/hour. 233 measured cities feed
the [Rate Index](../rate-index.md). See [MCP tools](mcp-tools.md).
