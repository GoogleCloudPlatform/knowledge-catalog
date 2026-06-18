---
type: Documentation
title: Antigravity Platform Overview
layer: synthesis
description: >-
  Google Antigravity is an agent-first development platform built as a fork of
  VS Code. It shifts from traditional AI code assistance to a system where
  autonomous agents plan, write, test, and debug code across entire projects.
tags:
- antigravity
- agent-platform
- IDE
- agent-orchestration
timestamp: "2026-06-18T15:00:00Z"
---

Google Antigravity is an agent-first development platform [released by Google on November 18, 2025](https://en.wikipedia.org/wiki/Google_Antigravity). Built as a fork of VS Code, it is powered primarily by the Gemini 3 model family with support for Claude Sonnet 4.6 and GPT-OSS-120B.

The platform operates on a core shift from traditional AI code assistance to an [agent-first paradigm](https://antigravity.google/blog/introducing-google-antigravity) where autonomous AI agents plan, write, test, and debug code across entire projects. This is a fundamentally different interaction model from chat-based code generation: agents operate across multiple surfaces simultaneously (editor, terminal, browser) with greater autonomy.

## Two Views

Antigravity offers two primary interaction modes. The **Editor View** provides a traditional IDE-like interface with an agent sidebar for synchronous collaboration. The **Manager View** is a mission-control interface for orchestrating multiple agents in parallel across different workspaces, enabling [asynchronous task execution](concepts/agents.md).

## Key Tenets

Three design principles define the platform. **Autonomy** means agents work across multiple surfaces (editor, terminal, browser) without requiring hand-holding at each step. **Feedback** lets users comment on agent-produced artifacts to steer direction without stopping execution. **Self-improvement** means agents learn from past work and feedback, contributing to a shared knowledge base over time.

## Projects as the Organizational Unit

Antigravity uses [projects](concepts/projects.md) to define the environment and scope for an agent. A project is a combination of one or more folders (e.g., a frontend and backend repo) that gives an agent all necessary context. Each project has its own [isolated agent settings](concepts/security-presets.md) for security, permissions, and allowed tools, independent from global configuration.

## Artifacts as Trust

Rather than exposing raw tool calls to users, agents produce [artifacts](concepts/artifacts.md): verifiable deliverables like task lists, implementation plans, walkthroughs, screenshots, and browser recordings. Artifacts allow users to validate the agent's work at a higher, more natural abstraction level.

## SOURCES

- [Project Model](concepts/projects.md) — Project composition with folders and isolated settings
- [Agent Lifecycle](concepts/agents.md) — Agent states, security presets, and behavior configuration
- [Artifact Types](concepts/artifacts.md) — Verifiable deliverables and the trust model
- [Security Presets](concepts/security-presets.md) — Permission scoping and command execution controls
- [Agent Workflow](guides/agent-workflow.md) — Task planning and execution from seed to artifact
- [Multi-Agent Orchestration](guides/multi-agent-orchestration.md) — Manager View patterns for parallel coordination

## Citations

- <https://antigravity.google/blog/introducing-google-antigravity>
- <https://en.wikipedia.org/wiki/Google_Antigravity>
- <https://codelabs.developers.google.com/getting-started-google-antigravity>
