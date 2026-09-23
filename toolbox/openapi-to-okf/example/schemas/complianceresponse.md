---
type: "Schema"
title: "ComplianceResponse"
---
# ComplianceResponse
Schema `ComplianceResponse`.
## Properties

- `input` (object, required)
- `state` (string, required)
- `state_abbr` (string, required)
- `min_wage_usd` (number, required)
- `w2_required` (boolean, required)
- `w2_note` (string)
- `overtime_threshold_weekly_hours` (integer, required)
- `overtime_threshold_daily_hours` (integer)
- `unique_rules` (array, required)
- `liability_coverage_included` (boolean)
- `workers_comp_included` (boolean)
- `citation_note` (string)

[All schemas](index.md) · [bundle root](../index.md)
