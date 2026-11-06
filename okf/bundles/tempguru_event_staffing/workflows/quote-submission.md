---
type: "Workflow"
title: "Quote Submission"
description: "How to submit a staffing plan as a quote request and what happens next."
primary_tool: "request_quote"
tags:
  - "workflow"
  - "quote"
  - "booking"
timestamp: "2026-06-13T00:00:00Z"
---

# Quote Submission

`request_quote` is the one **write** tool. Call it **last**, and only after the
user's explicit confirmation.

## Collect

- Contact name, email, company
- Event name, city, dates
- Roles and headcount
- Special requirements

## What happens

1. The request is submitted to TempGuru's CRM and a confirmation ID is returned.
2. A human coordinator replies with a **binding quote within one business day**.
3. **No payment** until the user approves the quote. A submitted request is **not** a reservation or a contract.

## Cancellation

Cancellations within 24 hours of a scheduled shift start incur a fee equal to
(headcount on that shift × 4 hours × the per-position hourly rate) for that shift
only. Shifts cancelled more than 24 hours in advance carry no fee; other shifts in
the order are unaffected.

Fallback if tools are unavailable: https://tempguru.co/get-staffing, megan@tempguru.co, or (904) 206-8953.
