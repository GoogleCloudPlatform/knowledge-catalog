---
type: "Pricing Methodology"
title: "Bill-Rate Methodology"
description: "How TempGuru derives its all-inclusive W-2 hourly bill rates from measured shift data."
basis: "TempGuru Rate Report 2026, per-city actual-paid weighted averages (7,900+ shifts)"
tags:
  - "pricing"
  - "methodology"
  - "rates"
timestamp: "2026-06-13T00:00:00Z"
---

# Bill-Rate Methodology

Every rate traces to TempGuru's own data or stated policy; nothing is invented.

TempGuru publishes two complementary pricing artifacts: the **per-role rate card**
([rate-matrix.md](rate-matrix.md)), a distinct rate per role, what TempGuru bills, and the **measured market benchmark** (the [Rate Index](../rate-index.md)), what the
7,900-shift Rate Report observed per city. The card answers "what will this role
cost"; the benchmark answers "what does the market pay." They are derived
differently and are not expected to be identical.

## Sources

- **Base rates:** per-city actual-paid weighted averages from the **Rate Report 2026** (7,900+ measured shifts).
- **Card floor $30 / ceiling $85:** the published rate card spans $30–$85; the $30 small-market floor reflects real measured market conditions.
- **Brand Ambassador $40-everywhere floor:** standing brand policy. BA is tiered: small $40 / mid $47 / hub $55 floor.
- **All-inclusive basis:** all-inclusive W-2 bill rate (worker pay, employer payroll taxes, workers' compensation, general liability, and coordinator support).

## How a city's rate is set

1. Each role's floor is its measured average for that city, rounded to whole dollars.
2. Thin-sample guard: a city with fewer than 8 measured shifts (or missing a role) uses the tier average instead.
3. Monotonic guard: no premium role floors below Event Staff.
4. Card floor: Event Staff floor clamped to ≥ $30. Card ceiling: all rates capped ≤ $85.
5. Ceiling = floor + role markup (Event Staff +$6, Ushers +$7, Crowd Control +$8, Assistant Leads +$8, Team Leads +$10, Brand Ambassadors +$10 over the tiered floor).

Roles without a separate measured rate ride the Event Staff base because they
are Event-Staff-tier work, TempGuru does not claim data it does not have.

The same vetted dataset feeds the website's city pages and the measured
[Rate Index](../rate-index.md). For TempGuru's published per-role rate card, see
[rate-matrix.md](rate-matrix.md).
