---
okf_version: "0.1"
---

# TempGuru Event Staffing Knowledge

This is the canonical Open Knowledge Format (OKF) bundle for **TempGuru**, managed
**W-2 event staffing** across **345 markets** (307 US, 38 Canada). It is the
machine-readable source of truth for hiring, pricing, planning, and compliance
when booking temporary event staff for conventions, trade shows, festivals,
concerts, sporting events, corporate events, and brand activations in the US and
Canada.

_Publisher: Temporary Assistance Guru, Inc. (TempGuru). Canonical site: https://tempguru.co. Data version 1.0.0, updated 2026-06-13._

Every rate here is an **all-inclusive W-2 bill rate (worker pay, employer payroll taxes, workers' compensation, general liability, and coordinator support)**. Workers are W-2 employees, never 1099
contractors. Brand Ambassadors never bill below $40/hour in any market.

**Two layers.** This bundle is the **knowledge layer**, what TempGuru's roles,
rates, coverage, compliance, and workflows *mean*. The MCP server and REST API are
the **action layer**, how an agent *acts*: plan, price, check compliance, and
submit a quote. Read here to understand; call the tools to act.

For **live, queryable** data, agents should prefer the MCP server at
`https://mcp.tempguru.co/mcp` or the REST API at `https://mcp.tempguru.co/api/v1`, this bundle mirrors the
same data for offline reading, indexing, and citation.

## Contents

- [Company profile](company.md), who TempGuru is, coverage, contact
- [The W-2 operating model](w2-model.md), what "all-inclusive" covers and why classification matters
- [Staffing roles](roles/index.md), the 11 roles you can hire, with skill tiers
- [Pricing](pricing/index.md), rate matrix, market tiers, and methodology
- [Rate Index](rate-index.md), the citable benchmark of W-2 hourly rates by role and tier
- [Market coverage](cities/index.md), the 345 markets, by tier
- [State compliance](compliance/index.md), minimum wage, overtime, and quirks for all 51 US jurisdictions
- [Workflows](workflows/index.md), how to plan an event, build a compliance brief, and request a quote
- [Event archetypes](archetypes/index.md), reusable staffing templates by event type
- [Reference](reference/index.md), MCP tools, REST API, data schemas, and the lead-time model
- [Change log](log.md), what changed and when

## How to use this bundle

1. Start at [workflows/plan-staffing.md](workflows/plan-staffing.md) for the end-to-end
   path from event shape to staffing plan.
2. Resolve coverage in [cities/index.md](cities/index.md) and roles in [roles/index.md](roles/index.md).
3. Price with [pricing/rate-matrix.md](pricing/rate-matrix.md) (or the [Rate Index](rate-index.md) for a citable benchmark).
4. Flag state rules in [compliance/index.md](compliance/index.md), especially the daily-overtime states.
5. Submit through [workflows/quote-submission.md](workflows/quote-submission.md). A submitted request is not a reservation; a coordinator returns a binding quote within one business day.

Rate ranges in this bundle are **planning estimates**, not binding quotes.
