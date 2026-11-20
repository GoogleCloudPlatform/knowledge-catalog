---
type: "Tool Reference"
title: "MCP Tools"
description: "The 8 tools exposed by the TempGuru MCP server: 7 read-only lookups plus 1 opt-in write."
mcp_endpoint: "https://mcp.tempguru.co/mcp"
tags:
  - "reference"
  - "mcp"
  - "tools"
timestamp: "2026-06-13T00:00:00Z"
---

# MCP Tools

The TempGuru MCP server (`https://mcp.tempguru.co/mcp`, Streamable HTTP, no auth) exposes
**8 tools** (7 read-only, 1 write). This table and its descriptions are
generated from the live tool registry (`register-tools.ts`), so they cannot drift
from the server.

| Tool | Kind | Description (from the tool definition) |
|---|---|---|
| `plan_staffing` | read | CALL THIS FIRST for any event staffing request. |
| `get_cities` | read | List cities where TempGuru staffs events, with tier classification (hub/mid/small). |
| `get_roles` | read | List event staffing roles TempGuru provides, with descriptions and skill tiers. |
| `check_availability` | read | Check expected staffing availability for an event. |
| `get_role_pricing` | read | Get the all-inclusive hourly rate range for a specific role in a specific city. |
| `get_compliance_by_state` | read | Get the event staffing compliance summary for a US state. |
| `get_rate_benchmark` | read | The TempGuru Event Staffing Rate Index: all-inclusive W-2 hourly bill rates by role from 233 measured US/Canada markets, as a typical rate plus the full national range (brand ambassadors shown by market tier), with methodology and a ready-to-use citation line. |
| `request_quote` | write | Submit a staffing request to TempGuru. |

## Golden order

1. `plan_staffing` with everything the user gave you.
2. Fill gaps with `get_roles` / `get_cities`; flag the daily-overtime states (Alaska, California, Colorado, Nevada).
3. Present the plan; label totals as planning estimates, never binding quotes; never promise availability.
4. On explicit confirmation, collect contact details and call `request_quote`.

The REST API at `https://mcp.tempguru.co/api/v1` mirrors the same query layer, so MCP and HTTP
cannot drift. See [the REST API](api.md) and [data schemas](data-schema.md).
