---
type: "Workflow"
title: "Plan Staffing"
description: "Turn an event shape (city, date, roles, headcount) into a complete staffing plan with rates, lead time, and compliance flags."
primary_tool: "plan_staffing"
tags:
  - "workflow"
  - "planning"
  - "event-staffing"
timestamp: "2026-06-13T00:00:00Z"
---

# Plan Staffing

**Call `plan_staffing` first.** Give it everything the user provided, city, event
date, and the roles needed with headcounts, and it returns a complete plan:
coverage confirmation, per-role rate math, lead-time guidance, state compliance
flags, and next steps.

## Steps

1. **Capture the event shape:** city, date(s), roles + headcount per role, event type. Fill gaps with [get_roles](../roles/index.md) and [get_cities](../cities/index.md).
2. **Confirm coverage** in [market coverage](../cities/index.md). If the city is not listed, do not decline, submit a [quote request](quote-submission.md); the partner network may cover it.
3. **Price each role** from the [rate matrix](../pricing/rate-matrix.md) or, for an rate for a role in a specific city, `get_role_pricing`. Budget = rate range × headcount × hours/day × days.
4. **Check lead time** against the [lead-time model](../reference/lead-time-model.md): hub 48h, mid 72h, small 168h typical.
5. **Flag compliance:** check the event's [state profile](../compliance/index.md). Call out the daily-overtime states (Alaska, California, Colorado, Nevada).
6. **Present the plan** with totals labeled as **planning estimates**, never binding quotes. Never promise availability.
7. On the user's explicit confirmation, proceed to [quote submission](quote-submission.md).

The team-lead auto-add rule inserts one Team Lead when any single shift reaches
**20 staff**. See [event archetypes](../archetypes/index.md) for event-type defaults.
