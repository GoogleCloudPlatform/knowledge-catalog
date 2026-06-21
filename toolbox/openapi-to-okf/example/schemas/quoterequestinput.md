---
type: "Schema"
title: "QuoteRequestInput"
description: "A confirmed staffing plan plus the contact details a coordinator needs to reply."
---
# QuoteRequestInput
A confirmed staffing plan plus the contact details a coordinator needs to reply. Mirrors the MCP `request_quote` tool's input schema exactly.
## Properties

- `contact_name` (string, required): Full name of the contact person.
- `contact_email` (string, required): Contact email address for the quote response.
- `company` (string, required): Company or organization name.
- `event_name` (string, required): Name of the event.
- `event_type` (string, required): Event type: trade-show, conference, festival, concert, sporting-event, corporate, brand-activation, or other.
- `city` (string, required): City where the event is held.
- `event_dates` (string, required): Event dates as a human-readable string.
- `roles` (array, required): Roles and headcount needed for the event.
- `budget_range` (string): Estimated total budget range if calculated.
- `attire` (string): Staff attire requirements.
- `special_requirements` (string): Any special requirements: language skills, certifications, overnight shifts, etc.
- `compliance_notes` (string): Any compliance flags surfaced by the compliance endpoint.

[All schemas](index.md) · [bundle root](../index.md)
