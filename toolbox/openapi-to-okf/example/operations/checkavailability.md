---
type: "API Operation"
title: "Lead-time guidance for an event"
description: "Use this when an agent wants to know whether TempGuru can typically staff an event at a given city and date, for example, 'is two weeks enough notice for Dallas?' Returns a recommendation in the se..."
method: "GET"
path: "/api/v1/availability"
resource: "https://mcp.tempguru.co/api/v1/availability"
operation_id: "checkAvailability"
tags:
  - "Planning"
---
# Lead-time guidance for an event
Use this when an agent wants to know whether TempGuru can typically staff an event at a given city and date, for example, 'is two weeks enough notice for Dallas?' Returns a recommendation in the set {yes, tight, rush, very-rush} based on the city's market tier and how far out the event is. **This is planning guidance, not a real-time reservation.** A confirmed booking requires a quote request at https://tempguru.co/get-staffing.
- **Operation:** `GET https://mcp.tempguru.co/api/v1/availability`
- **Tags:** Planning
## Parameters

- `city` (query, required): City name (e.g., 'Boston') or slug from /api/v1/cities (e.g., 'boston-event-staffing').
- `date` (query, required): Event date in ISO format (YYYY-MM-DD).
- `role` (query): Optional role slug or name. When provided, the response also includes the rate range for that role in the resolved city.
- `headcount` (query): Optional headcount for the event. Echoed in the response so agents can include it in downstream quote requests.

## Related schemas

- [AvailabilityResponse](../schemas/availabilityresponse.md)
- [Error](../schemas/error.md)

[All operations](index.md) · [bundle root](../index.md)
