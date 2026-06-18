---
type: Reference
title: Antigravity Artifact Types
layer: concept
description: >-
  Artifacts are verifiable deliverables that agents produce as proof of work:
  task lists, implementation plans, walkthroughs, screenshots, and browser
  recordings. They provide a higher abstraction level than raw tool calls.
tags:
- antigravity
- artifacts
- trust
- verification
timestamp: "2026-06-18T15:00:00Z"
---

Artifacts are the core trust mechanism in Antigravity. Rather than exposing raw tool calls to users, agents produce structured, verifiable deliverables that document what was done and why.

## Artifact Types

| Type | Purpose | Verification Method |
|------|---------|-------------------|
| Task List | Decomposition of a goal into sub-tasks with completion status | Human review |
| Implementation Plan | Architecture decisions, file changes, and dependency modifications | Human review, diff inspection |
| Walkthrough | Step-by-step explanation of what was built and how it works | Human review |
| Screenshot | Visual evidence of UI changes or rendered output | Visual inspection |
| Browser Recording | Session replay of agent interactions with web applications | Playback review |

## Feedback Loop

Users can [comment on artifacts](https://antigravity.google/blog/introducing-google-antigravity) to steer the agent without stopping execution. This creates a feedback loop where artifacts serve as both proof of work and communication medium. The agent incorporates the feedback and produces updated artifacts.

## Knowledge Base Contribution

Agents that learn from past work contribute to a shared [knowledge base](https://codelabs.developers.google.com/getting-started-google-antigravity). Completed artifacts and their associated feedback become training material for future tasks, creating a compounding improvement cycle.

## SOURCES

- [Antigravity Platform Overview](antigravity-platform.md) — Artifacts as trust section and platform context
- [Agent Lifecycle](agents.md) — Producing state and artifact generation
- [Agent Workflow](../guides/agent-workflow.md) — Complete flow from seed to artifact

## Citations

- <https://antigravity.google/blog/introducing-google-antigravity>
- <https://codelabs.developers.google.com/getting-started-google-antigravity>
