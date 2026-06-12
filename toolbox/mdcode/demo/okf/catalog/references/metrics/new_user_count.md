---
type: Reference
resource: https://developers.google.com/analytics/bigquery/basic-queries
title: New User Count
description: The number of unique users who triggered a first_visit or first_open
  event.
tags:
- metric
timestamp: '2026-05-28T22:51:38+00:00'
---

The number of unique users who triggered a `first_visit` or `first_open` event.

```sql
SUM(is_new_user)
-- where is_new_user is MAX(IF(event_name IN ('first_visit', 'first_open'), 1, 0)) grouped by user_pseudo_id
```

# Citations
- https://developers.google.com/analytics/bigquery/basic-queries
