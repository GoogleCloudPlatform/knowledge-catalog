---
type: "API Operation"
title: "State-level employment compliance summary"
description: "Use this when an agent needs an at-a-glance summary of event staffing compliance for a specific state, minimum wage, weekly and daily overtime thresholds, and state-specific quirks (California meal..."
method: "GET"
path: "/api/v1/compliance"
resource: "https://mcp.tempguru.co/api/v1/compliance"
operation_id: "getComplianceByState"
tags:
  - "Compliance"
---
# State-level employment compliance summary
Use this when an agent needs an at-a-glance summary of event staffing compliance for a specific state, minimum wage, weekly and daily overtime thresholds, and state-specific quirks (California meal-break rules, NY spread-of-hours, etc.). Useful for planning multi-state events and for explaining why W-2 staffing matters in jurisdictions with strict labor enforcement. **Informational only, not legal advice.** Consult employment counsel for binding interpretation.
- **Operation:** `GET https://mcp.tempguru.co/api/v1/compliance`
- **Tags:** Compliance
## Parameters

- `state` (query, required): Two-letter US state code (e.g., 'CA') or full name (e.g., 'California'). All 50 states plus DC supported.

## Related schemas

- [ComplianceResponse](../schemas/complianceresponse.md)
- [Error](../schemas/error.md)

[All operations](index.md) · [bundle root](../index.md)
