---
type: Guide
title: Antigravity Agent Workflow
layer: analysis
description: >-
  The end-to-end workflow of an Antigravity agent: receiving a task, planning
  the approach, executing across surfaces, producing artifacts, and incorporating
  feedback.
tags:
- antigravity
- workflow
- agents
- task-execution
timestamp: "2026-06-18T15:00:00Z"
---

An Antigravity agent follows a structured workflow from the moment it receives a task to the delivery of verifiable [artifacts](concepts/artifacts.md).

## Phase 1: Task Reception and Planning

The agent receives a task within the scope of a [project](concepts/projects.md). It analyzes the project structure, reads relevant files, and formulates an implementation plan. This plan includes the files to modify, the architectural approach, and the expected outcomes. The plan itself is [captured as an artifact](concepts/artifacts.md) the user can review.

## Phase 2: Execution

The agent writes code, runs terminal commands, and navigates the browser surface as needed. During execution, the agent respects the project's [security presets](concepts/security-presets.md). If the preset requires review, the agent pauses before executing commands. If autonomous, it proceeds through the full sequence.

## Phase 3: Verification

After implementation, the agent tests its output against the task requirements. It runs tests, checks build output, and captures screenshots or browser recordings as evidence. Failed verification triggers a return to Phase 2 with updated context.

## Phase 4: Artifact Production

The agent produces structured artifacts documenting what was done: a completed task list, implementation summary, and visual evidence. The user reviews these artifacts and can provide feedback, which the agent incorporates in a subsequent iteration.

## SOURCES

- [Agent Lifecycle](../concepts/agents.md) — State transitions during the workflow
- [Artifact Types](../concepts/artifacts.md) — Types of deliverables agents produce
- [Security Presets](../concepts/security-presets.md) — Autonomy controls during execution
- [Multi-Agent Orchestration](multi-agent-orchestration.md) — Coordinating multiple agents in parallel

## Citations

- <https://antigravity.google/blog/introducing-google-antigravity>
- <https://codelabs.developers.google.com/getting-started-google-antigravity>
