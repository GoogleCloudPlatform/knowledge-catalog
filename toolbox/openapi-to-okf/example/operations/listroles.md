---
type: "API Operation"
title: "List event staffing roles"
description: "Use this when an agent needs the canonical list of roles TempGuru staffs (brand ambassadors, registration, hospitality, setup, ushers, gate, crowd control, guest services, booth monitors, team leads)."
method: "GET"
path: "/api/v1/roles"
resource: "https://mcp.tempguru.co/api/v1/roles"
operation_id: "listRoles"
tags:
  - "Discovery"
---
# List event staffing roles
Use this when an agent needs the canonical list of roles TempGuru staffs (brand ambassadors, registration, hospitality, setup, ushers, gate, crowd control, guest services, booth monitors, team leads). The returned `slug` values are the keys to use in the pricing and availability endpoints.
- **Operation:** `GET https://mcp.tempguru.co/api/v1/roles`
- **Tags:** Discovery

## Related schemas

- [RolesResponse](../schemas/rolesresponse.md)

[All operations](index.md) · [bundle root](../index.md)
