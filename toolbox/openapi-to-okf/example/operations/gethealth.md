---
type: "API Operation"
title: "Service health probe"
description: "Use this when an agent or monitoring system wants to verify the API is alive and check which version is running."
method: "GET"
path: "/api/v1/health"
resource: "https://mcp.tempguru.co/api/v1/health"
operation_id: "getHealth"
tags:
  - "Operational"
---
# Service health probe
Use this when an agent or monitoring system wants to verify the API is alive and check which version is running. Returns immediately with no caching. Suitable as the target of an api-catalog `status` link (RFC 9727).
- **Operation:** `GET https://mcp.tempguru.co/api/v1/health`
- **Tags:** Operational

## Related schemas

- [HealthResponse](../schemas/healthresponse.md)

[All operations](index.md) · [bundle root](../index.md)
