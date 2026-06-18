---
type: Reference
title: Antigravity Security Presets
layer: concept
description: >-
  Security presets control what agents can access and execute within a project.
  Settings are isolated per project and cover terminal command execution, file
  access, and MCP tool permissions.
tags:
- antigravity
- security
- permissions
- presets
timestamp: "2026-06-18T15:00:00Z"
---

Security presets are per-project configurations that control [what an agent can access and execute](https://codelabs.developers.google.com/getting-started-google-antigravity). Each project has its own isolated security settings, preventing cross-project contamination.

## Security Preset Levels

The security preset determines how terminal commands are handled:

- **Allow All** — Commands execute without review
- **Review** — Commands require user approval before execution
- **Block All** — No terminal commands permitted

## Agent Behavior Configuration

The behavior setting controls agent autonomy:

- **Autonomous** — The agent proceeds through planning, execution, and verification without pausing for approval
- **Review Required** — The agent requests confirmation before significant actions

## Permission Scoping

Permissions are granular and per-project:

- **File Paths** — Which directories the agent can read and write
- **URLs** — Which external URLs the agent can access
- **MCP Tools** — Which Model Context Protocol tools the agent can invoke

## SOURCES

- [Antigravity Platform Overview](antigravity-platform.md) — Platform security context
- [Project Model](projects.md) — Settings isolation per project
- [Agent Lifecycle](agents.md) — How autonomy levels affect agent behavior

## Citations

- <https://codelabs.developers.google.com/getting-started-google-antigravity>
