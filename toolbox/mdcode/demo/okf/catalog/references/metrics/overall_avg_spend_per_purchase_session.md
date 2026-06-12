---
type: Reference
resource: https://developers.google.com/analytics/bigquery/advanced-queries
title: Overall Average Spend Per Purchase Session
description: The overall average amount spent across all unique purchase sessions.
tags:
- metric
- ecommerce
timestamp: '2026-05-28T22:52:32+00:00'
---

The overall average amount spent across all unique purchase sessions.

```sql
AVG(total_session_spend)
-- where total_session_spend is SUM(COALESCE(...)) for event_name = 'purchase' events within a session, grouped by user_pseudo_id and ga_session_id
```

# Citations
- https://developers.google.com/analytics/bigquery/advanced-queries
