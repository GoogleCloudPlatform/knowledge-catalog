---
type: Reference
resource: https://developers.google.com/analytics/bigquery/advanced-queries
title: Average Spend Per Purchase Session By User
description: The average amount of money spent per purchase session for each individual
  user.
tags:
- metric
- ecommerce
timestamp: '2026-05-28T22:52:29+00:00'
---

The average amount of money spent per purchase session for each individual user.

```sql
AVG(total_session_spend)
-- where total_session_spend is SUM(COALESCE(...)) for event_name = 'purchase' events within a session, grouped by user_pseudo_id and ga_session_id
```

# Citations
- https://developers.google.com/analytics/bigquery/advanced-queries
