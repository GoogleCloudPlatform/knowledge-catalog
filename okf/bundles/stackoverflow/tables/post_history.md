---
type: BigQuery Table
resource: https://bigquery.googleapis.com/v2/projects/bigquery-public-data/datasets/stackoverflow/tables/post_history
title: Post History
description: Tracks the revision history of posts on Stack Overflow, including details
  about event types, associated users, and content changes.
tags:
- stackoverflow
- post history
- revisions
- edits
- schema
- data dump
timestamp: '2026-05-28T23:33:54+00:00'
---

This table, part of the [Stack Overflow dataset](../datasets/stackoverflow.md), records every historical event related to posts, such as edits, rollbacks, and changes in post type. Each row represents a single historical event for a particular post, identified by `post_id`, with the event\'s timestamp recorded in `creation_date`. This allows for a comprehensive audit trail of how content on Stack Overflow evolves over time.

### Schema

- `id` (INTEGER) - Unique identifier for the post history entry.
- `post_history_type_id` (INTEGER) - An integer representing the type of history event. See the [Post History Type IDs reference](../references/post_history_type_ids.md) for possible values.
- `post_id` (INTEGER) - The ID of the post to which this history event belongs. Links to `posts_questions` or `posts_answers` tables.
- `revision_guid` (STRING) - A GUID that groups multiple history records caused by a single action.
- `creation_date` (TIMESTAMP) - The timestamp when the history event occurred (e.g., `2009-03-05T22:28:34.823`).
- `user_id` (INTEGER) - The ID of the user who performed the action, if applicable. Links to the `users` table.
- `user_display_name` (STRING) - Populated if a user has been removed and is no longer referenced by `user_id`; also happens to the author of a migrated post. Nullable.
- `comment` (STRING) - A brief comment describing the history event. This field can also contain specific IDs based on `PostHistoryTypeId`:
    - If `PostHistoryTypeId = 10`, it contains the `CloseReasonId`. See the [Close Reason Types reference](../references/close_reason_types.md).
    - If `PostHistoryTypeId` is `33` or `34`, it contains the `PostNoticeId`.
- `text` (STRING) - A raw version of the new value for a given revision. This field can also contain specific JSON encoded strings based on `PostHistoryTypeId`:
    - If `PostHistoryTypeId` is `10, 11, 12, 13, 14, 15, 19, 20, 35`, it contains a JSON encoded string with all users who have voted for that `PostHistoryTypeId`.
    - If it is a duplicate close vote, the JSON string contains an array of original questions as `OriginalQuestionIds`.
    - If `PostHistoryTypeId = 17`, it contains migration details (`from <url>` or `to <url>`).
- `content_license` (STRING) - Indicates the Creative Commons license under which the content is licensed.

### Common query patterns

```sql
SELECT
  creation_date,
  post_history_type_id,
  user_id,
  comment,
  text
FROM
  `bigquery-public-data.stackoverflow.post_history`
WHERE
  post_id = 456789 -- Example post ID
ORDER BY
  creation_date DESC
LIMIT 10;
```

```sql
SELECT
  post_history_type_id,
  COUNT(*) AS event_count
FROM
  `bigquery-public-data.stackoverflow.post_history`
GROUP BY
  post_history_type_id
ORDER BY
  event_count DESC;
```

```sql
SELECT
  t2.display_name,
  COUNT(t1.id) AS edit_count
FROM
  `bigquery-public-data.stackoverflow.post_history` AS t1
INNER JOIN
  `bigquery-public-data.stackoverflow.users` AS t2
ON
  t1.user_id = t2.id
WHERE
  t1.post_history_type_id = 2 -- Assuming \'2\' means \'Post Edited\'
GROUP BY
  t2.display_name
ORDER BY
  edit_count DESC
LIMIT 5;
```

### Citations

[1] [BigQuery Public Dataset: Stack Overflow Post History](https://bigquery.googleapis.com/v2/projects/bigquery-public-data/datasets/stackoverflow/tables/post_history)
[2] [Database schema documentation for the public data dump and SEDE](https://meta.stackexchange.com/questions/2677/database-schema-documentation-for-the-public-data-dump-and-sede)
