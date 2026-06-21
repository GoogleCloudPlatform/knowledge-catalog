---
type: "Schema"
title: "AvailabilityResponse"
---
# AvailabilityResponse
Schema `AvailabilityResponse`.
## Properties

- `input` (object, required)
- `city_found` (boolean, required)
- `city` (string, required)
- `state` (string, required)
- `city_tier` (string, required)
- `event_date` (string, required)
- `days_until_event` (integer, required)
- `typical_lead_time_hours` (integer, required)
- `recommendation` (string, required): yes = comfortable window; tight = at or near typical lead time; rush = inside lead time; very-rush = <24h.
- `role` (object)
- `count` (integer)
- `notes` (array, required)

[All schemas](index.md) · [bundle root](../index.md)
