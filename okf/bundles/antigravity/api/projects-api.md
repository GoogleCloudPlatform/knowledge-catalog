---
type: API Reference
title: Antigravity Projects API
layer: concept
description: >-
  REST API for creating, reading, updating, and deleting Antigravity project
  workspaces. Each project scopes agent activity to a specific set of folders
  with isolated security and behavior settings.
tags:
- antigravity
- api
- projects
- rest
timestamp: "2026-06-18T15:00:00Z"
---

The Projects API manages Antigravity [project workspaces](concepts/projects.md). Each project defines the environment and scope for agent activity.

## Endpoints

### Create Project

`POST /v1/projects`

Creates a new project workspace with specified folders and settings.

### Get Project

`GET /v1/projects/{project_id}`

Returns the project's current settings, folder composition, and agent configuration.

### Update Project

`PATCH /v1/projects/{project_id}`

Updates project settings including security presets, agent behavior, and allowed tools.

### Delete Project

`DELETE /v1/projects/{project_id}`

Removes the project workspace and associated agent state.

## Schema

```json
{
  "project_id": "string",
  "name": "string",
  "folders": ["path/to/frontend", "path/to/backend"],
  "settings": {
    "security_preset": "review",
    "agent_behavior": "autonomous",
    "allowed_files": ["src/", "tests/"],
    "allowed_urls": ["https://api.example.com"],
    "mcp_tools": ["github", "docker"]
  },
  "created_at": "2026-06-18T15:00:00Z"
}
```

## SOURCES

- [Project Model](../concepts/projects.md) — Project semantics and settings isolation
- [Security Presets](../concepts/security-presets.md) — Security configuration per project
- [Antigravity Platform Overview](../concepts/antigravity-platform.md) — Platform architecture

## Citations

- <https://codelabs.developers.google.com/getting-started-google-antigravity>
