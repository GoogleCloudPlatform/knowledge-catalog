---
type: "API Operation"
title: "List cities TempGuru serves"
description: "Use this when an agent needs the canonical list of cities where TempGuru has a dedicated market presence, or wants to filter by state or by tier (hub / mid / small)."
method: "GET"
path: "/api/v1/cities"
resource: "https://mcp.tempguru.co/api/v1/cities"
operation_id: "listCities"
tags:
  - "Discovery"
---
# List cities TempGuru serves
Use this when an agent needs the canonical list of cities where TempGuru has a dedicated market presence, or wants to filter by state or by tier (hub / mid / small). Tier classification is used everywhere else in the API to determine lead times and rate bands.
- **Operation:** `GET https://mcp.tempguru.co/api/v1/cities`
- **Tags:** Discovery
## Parameters

- `state` (query): Filter by state. Accepts either a 2-letter postal code (e.g., 'CA') or a full state name (e.g., 'California'). US states and Canadian provinces both supported.
- `tier` (query): Filter by market tier. 'hub' = 25 major metros (NYC, LA, Boston, etc.); 'mid' = 129 secondary markets; 'small' = 191 tertiary markets.

## Related schemas

- [CitiesResponse](../schemas/citiesresponse.md)
- [Error](../schemas/error.md)

[All operations](index.md) · [bundle root](../index.md)
