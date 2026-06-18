---
type: Reference
title: Antigravity Project Model
layer: concept
description: >-
  Projects define the environment and scope for an Antigravity agent. A project
  combines one or more folders with isolated settings for security, permissions,
  and allowed tools.
tags:
- antigravity
- projects
- workspaces
- configuration
timestamp: "2026-06-18T15:00:00Z"
---

A project is the core organizational unit in Antigravity. It defines the environment and scope for an agent by combining one or more folders (for example, a frontend and backend repository) that give the agent all necessary context to work on a task.

## Settings Isolation

Each project has its own isolated agent settings, independent from the global configuration. This allows different projects to have different security postures, tool access, and model configurations without cross-contamination.

Three categories of settings exist:

- **Security Preset** — Controls whether terminal commands require review before execution
- **Agent Behavior** — Determines autonomy level: fully autonomous or requiring step-by-step approval
- **Permissions** — Scopes file paths, URLs, and MCP tool access per project

## Conversation Organization

Interactions with agents are organized into [conversation threads](https://codelabs.developers.google.com/getting-started-google-antigravity) grouped under a project. Users can rename conversations, start new ones within a project, and access conversation history.

## Relationship to Workspaces

A project is not tied to a single workspace. It can span multiple directories and repositories, giving the agent a unified view of related codebases. This is distinct from the VS Code workspace model where scope is limited to a single root folder.

## SOURCES

- [Antigravity Platform Overview](antigravity-platform.md) — Platform architecture and project context
- [Security Presets](security-presets.md) — Security configuration per project
- [Agent Workflow](../guides/agent-workflow.md) — How agents operate within a project scope

## Citations

- <https://codelabs.developers.google.com/getting-started-google-antigravity>
