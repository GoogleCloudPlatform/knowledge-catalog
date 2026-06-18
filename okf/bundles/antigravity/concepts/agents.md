---
type: Reference
title: Antigravity Agent Lifecycle
layer: concept
description: >-
  Antigravity agents operate across multiple surfaces with configurable
  autonomy levels. Agents can work synchronously in Editor View or
  asynchronously in Manager View.
tags:
- antigravity
- agents
- lifecycle
- autonomy
timestamp: "2026-06-18T15:00:00Z"
---

Antigravity agents operate with a lifecycle that spans multiple interaction surfaces and autonomy levels. Unlike traditional code assistants that respond to individual prompts, Antigravity agents [plan, execute, and verify](https://antigravity.google/blog/introducing-google-antigravity) complex, multi-step tasks with minimal human intervention.

## Agent States

Agents in Antigravity transition through several states during a task:

- **Planning** — The agent analyzes the project scope and formulates an approach
- **Executing** — The agent writes code, runs commands, and navigates files
- **Verifying** — The agent tests its output against the task requirements
- **Producing** — The agent generates artifacts (task lists, screenshots, recordings) as proof of work

## Autonomy Levels

The user configures an agent's autonomy per project. At higher autonomy, the agent proceeds through states without pausing for approval at each step. At lower autonomy, the agent requests confirmation before executing terminal commands or modifying files.

## Cross-Surface Operation

Agents operate across three surfaces simultaneously:

- **Editor** — Writing and modifying code files
- **Terminal** — Running commands and build processes
- **Browser** — Interacting with web applications and APIs

This cross-surface capability is what distinguishes agent-first platforms from chat-based code generation. The agent doesn't just suggest code changes; it executes the full development cycle.

## SOURCES

- [Antigravity Platform Overview](antigravity-platform.md) — Two views and key tenets
- [Security Presets](security-presets.md) — Autonomy configuration and permissions
- [Multi-Agent Orchestration](../guides/multi-agent-orchestration.md) — Parallel agent coordination in Manager View

## Citations

- <https://antigravity.google/blog/introducing-google-antigravity>
