---
type: BigQuery Table
resource: https://bigquery.googleapis.com/v2/projects/bigquery-public-data/datasets/stackoverflow/tables/votes
title: Votes
description: This table contains information about votes cast on posts within the
  Stack Overflow platform, including the vote type, associated post and user, and
  bounty details.
tags:
- votes
- posts
- stackoverflow
- community
- engagement
- schema
- data dump
timestamp: '2026-05-28T23:36:03+00:00'
---

This table, `votes`, from the [stackoverflow](../datasets/stackoverflow.md) dataset, records individual voting events on various posts (questions, answers, etc.) within the Stack Overflow platform. Each row represents a single vote, providing details such as the unique vote identifier, the timestamp of the vote, the ID of the post that received the vote, and the type of vote (e.g., upvote, downvote, favorite). This table is crucial for analyzing user engagement, post popularity, and the overall quality assessment mechanisms within the Stack Overflow community. The grain of this table is one row per vote event, and it captures historical voting data from its creation date up to the last modification.

# Schema

- `id` (INTEGER) - Unique identifier for the vote.
- `post_id` (INTEGER) - The ID of the post to which the vote was cast. Links to `posts_questions` or `posts_answers` tables.
- `vote_type_id` (INTEGER) - The type of vote. See the [Vote Types reference](../references/vote_types.md) for a comprehensive list.
- `user_id` (INTEGER) - The ID of the user who cast the vote. Present only if `VoteTypeId` is `5` (Favorite/Bookmark) or `8` (BountyStart); -1 if user is deleted. Nullable. Links to the `users` table.
- `creation_date` (TIMESTAMP) - The date when the vote was cast. Time data is purposefully removed to protect user privacy.
- `bounty_amount` (INTEGER) - The amount of bounty associated with the vote. Present only if `VoteTypeId` is `8` (BountyStart) or `9` (BountyClose). Nullable.

# Common query patterns

```sql
-- Get the total number of votes for each vote type
SELECT
  vote_type_id,
  COUNT(id) AS total_votes
FROM
  `bigquery-public-data.stackoverflow.votes`
GROUP BY
  vote_type_id
ORDER BY
  total_votes DESC;
```

```sql
-- Find the top 10 most voted posts by summing up all votes (assuming all vote_type_ids contribute positively)
SELECT
  post_id,
  COUNT(id) AS total_votes
FROM
  `bigquery-public-data.stackoverflow.votes`
GROUP BY
  post_id
ORDER BY
  total_votes DESC
LIMIT 10;
```

```sql
-- Count votes over time
SELECT
  DATE(creation_date) AS vote_date,
  COUNT(id) AS daily_votes
FROM
  `bigquery-public-data.stackoverflow.votes`
WHERE
  creation_date >= \'2020-01-01\' AND creation_date < \'2021-01-01\'
GROUP BY
  vote_date
ORDER BY
  vote_date;
```

# Citations
[1] [BigQuery Public Dataset: Stack Overflow Votes Table](https://bigquery.googleapis.com/v2/projects/bigquery-public-data/datasets/stackoverflow/tables/votes)
[2] [Database schema documentation for the public data dump and SEDE](https://meta.stackexchange.com/questions/2677/database-schema-documentation-for-the-public-data-dump-and-sede)
