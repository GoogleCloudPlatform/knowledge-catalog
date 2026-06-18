---
type: Guide
title: Multi-Agent Orchestration in Antigravity
layer: analysis
description: >-
  Antigravity's Manager View enables asynchronous coordination of multiple
  agents across different workspaces, supporting parallel task execution with
  independent per-project configuration.
tags:
- antigravity
- orchestration
- multi-agent
- manager-view
timestamp: "2026-06-18T15:00:00Z"
---

Antigravity's Manager View provides a mission-control interface for orchestrating multiple agents across different workspaces simultaneously. This enables [asynchronous task execution](https://antigravity.google/blog/introducing-google-antigravity) where agents continue working independently while the developer monitors progress.

## Parallel Agent Execution

Each agent in Manager View operates within its own [project scope](concepts/projects.md) with independent security and behavior settings. Agents can work on unrelated tasks across different repositories simultaneously, each with its own conversation thread and artifact stream.

## Asynchronous Coordination

Unlike the synchronous collaboration in Editor View, Manager View agents do not require the developer's attention at every step. Agents proceed through their [lifecycle](concepts/agents.md) autonomously, producing artifacts that the developer reviews when ready. This decouples agent throughput from human availability.

## Resource Isolation

Each agent operates with its own resource allocation, preventing one agent's workload from starving others. Security presets are per-agent, so [permission scoping](concepts/security-presets.md) is maintained even during parallel execution.

## SOURCES

- [Agent Lifecycle](../concepts/agents.md) — State transitions and autonomy levels
- [Project Model](../concepts/projects.md) — Per-project scope and isolation
- [Security Presets](../concepts/security-presets.md) — Per-agent security configuration
- [Agent Workflow](agent-workflow.md) — Individual agent workflow from planning to artifact

## Citations

- <https://antigravity.google/blog/introducing-google-antigravity>
