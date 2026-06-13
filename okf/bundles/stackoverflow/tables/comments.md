---
type: BigQuery Table
resource: https://bigquery.googleapis.com/v2/projects/bigquery-public-data/datasets/stackoverflow/tables/comments
title: Comments
description: This table contains comments made by users on posts within the Stack
  Overflow platform, including details about the comment text, score, and author,
  along with licensing information.
tags:
- stackoverflow
- comments
- community
- user-generated content
- schema
- data dump
timestamp: '2026-05-28T23:32:34+00:00'
---

The `comments` table in the [Stack Overflow dataset](../datasets/stackoverflow.md) captures all user-generated comments on various posts across the platform. Each row in this table represents a unique comment, providing details such as the comment\'s text, its creation timestamp, and a score reflecting its community reception. Comments are linked to the specific [posts](posts_questions.md) (questions or answers) they belong to via `post_id` and to the [users](users.md) who authored them via `user_id`. This table is crucial for analyzing user engagement, content quality feedback, and conversational threads on the platform.

# Schema
- `id` (INTEGER) - Unique identifier for the comment.
- `post_id` (INTEGER) - The ID of the post (question or answer) to which the comment belongs.
- `score` (INTEGER) - The score of the comment, reflecting upvotes and downvotes.
- `text` (STRING) - The content of the comment (Comment body).
- `creation_date` (TIMESTAMP) - The date and time the comment was posted.
- `user_display_name` (STRING) - The display name of the user who made the comment. Nullable.
- `user_id` (INTEGER) - The ID of the user who made the comment. Optional, absent if user has been deleted.
- `content_license` (STRING) - Indicates the Creative Commons license under which the content is licensed.

# Common query patterns
```sql
-- Retrieve the 10 most recent comments
SELECT
  id,
  text,
  creation_date,
  user_display_name
FROM
  `bigquery-public-data.stackoverflow.comments`
ORDER BY
  creation_date DESC
LIMIT 10;
```

```sql
-- Count comments per user
SELECT
  user_display_name,
  COUNT(id) AS total_comments
FROM
  `bigquery-public-data.stackoverflow.comments`
WHERE
  user_display_name IS NOT NULL
GROUP BY
  user_display_name
ORDER BY
  total_comments DESC
LIMIT 10;
```

```sql
-- Find comments with a high score for a specific post
SELECT
  id,
  text,
  score,
  creation_date
FROM
  `bigquery-public-data.stackoverflow.comments`
WHERE
  post_id = 45651 AND score > 5
ORDER BY
  score DESC;
```

# Citations
[1] [BigQuery Public Dataset: Stack Overflow Comments](https://bigquery.googleapis.com/v2/projects/bigquery-public-data/datasets/stackoverflow/tables/comments)
[2] [Database schema documentation for the public data dump and SEDE](https://meta.stackexchange.com/questions/2677/database-schema-documentation-for-the-public-data-dump-and-sede)
