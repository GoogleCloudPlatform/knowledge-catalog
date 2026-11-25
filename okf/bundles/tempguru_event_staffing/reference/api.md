---
type: "API Reference"
title: "REST API"
description: "HTTP mirror of the TempGuru event-staffing data, backed by the same query layer as the MCP tools."
api_base: "https://mcp.tempguru.co/api/v1"
openapi: "https://mcp.tempguru.co/openapi.json"
tags:
  - "reference"
  - "api"
  - "rest"
timestamp: "2026-06-13T00:00:00Z"
---

# REST API

The REST API at `https://mcp.tempguru.co/api/v1` exposes the same data as the [MCP tools](mcp-tools.md),
backed by the same query layer, there is no behavior drift between the two. This
table is generated from the OpenAPI 3.1 spec, so it cannot drift from the served API.

| Method & path | Summary |
|---|---|
| `GET /api/v1/cities` | List cities TempGuru serves |
| `GET /api/v1/roles` | List event staffing roles |
| `GET /api/v1/availability` | Lead-time guidance for an event |
| `GET /api/v1/pricing` | All-inclusive hourly rate range for a role in a city |
| `GET /api/v1/compliance` | State-level employment compliance summary |
| `POST /api/v1/quote-requests` | Submit a staffing quote request (the API's only write operation) |

OpenAPI 3.1 spec: `https://mcp.tempguru.co/openapi.json`. MCP discovery: `https://mcp.tempguru.co/.well-known/mcp.json`.
OKF discovery: `https://mcp.tempguru.co/.well-known/okf.json`. All rates are
all-inclusive W-2 bill rates; see [pricing](../pricing/index.md).
