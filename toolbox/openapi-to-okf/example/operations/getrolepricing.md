---
type: "API Operation"
title: "All-inclusive hourly rate range for a role in a city"
description: "Use this when an agent needs to quote a price range for a specific role in a specific city, for example, 'what do brand ambassadors cost in Boston?' Returns a hourly_range_low / hourly_range_high r..."
method: "GET"
path: "/api/v1/pricing"
resource: "https://mcp.tempguru.co/api/v1/pricing"
operation_id: "getRolePricing"
tags:
  - "Planning"
---
# All-inclusive hourly rate range for a role in a city
Use this when an agent needs to quote a price range for a specific role in a specific city, for example, 'what do brand ambassadors cost in Boston?' Returns a `hourly_range_low` / `hourly_range_high` range reflecting event-type and shift variability within that market tier. **All rates are all-inclusive W-2 bill rates** covering worker pay, payroll taxes, workers' comp, liability, and coordinator support. Rate ranges are planning estimates, a real quote requires event specifics.
- **Operation:** `GET https://mcp.tempguru.co/api/v1/pricing`
- **Tags:** Planning
## Parameters

- `role` (query, required): Role slug or display name (e.g., 'brand-ambassadors' or 'Brand Ambassadors'). See /api/v1/roles for the canonical list.
- `city` (query, required): City name or slug (e.g., 'Boston' or 'boston-event-staffing'). See /api/v1/cities for the canonical list.

## Related schemas

- [PricingResponse](../schemas/pricingresponse.md)
- [Error](../schemas/error.md)

[All operations](index.md) · [bundle root](../index.md)
