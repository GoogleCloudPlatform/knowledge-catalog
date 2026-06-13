---
type: BigQuery Table
resource: https://bigquery.googleapis.com/v2/projects/bigquery-public-data/datasets/stackoverflow/tables/tags
title: Tags
description: A table containing information about tags used on Stack Overflow, including
  tag names, counts, and references to their excerpt and wiki posts, along with moderation
  settings.
tags:
- stackoverflow
- tags
- community
- metadata
- schema
- data dump
timestamp: '2026-05-28T23:34:53+00:00'
---

This table, `tags`, from the [stackoverflow](../datasets/stackoverflow.md) dataset, provides a comprehensive list of all tags used across the Stack Overflow platform. Each row represents a unique tag, detailing its name, the total count of times it has been used, and references to its corresponding excerpt and wiki posts. This table is essential for understanding the topics and technologies discussed on Stack Overflow, allowing for analysis of tag popularity, trends, and content organization.

# Schema
The `tags` table contains the following fields:
- `id` (INTEGER) - Unique identifier for the tag.
- `tag_name` (STRING) - The name of the tag (e.g., \'python\', \'java\', \'javascript\').
- `count` (INTEGER) - The total number of times this tag has been used.
- `excerpt_post_id` (INTEGER) - The ID of the Post that holds the excerpt text of the tag. Nullable.
- `wiki_post_id` (INTEGER) - The ID of the Post that holds the wiki text of the tag. Nullable.
- `is_moderator_only` (BOOLEAN) - Indicates if the tag can only be used by moderators.
- `is_required` (BOOLEAN) - Indicates if the tag is required for certain post types.

# Common query patterns

1. Find the most popular tags:
```sql
SELECT
    tag_name,
    count
  FROM
    `bigquery-public-data.stackoverflow.tags`
  GROUP BY
    tag_name
  ORDER BY
    count DESC
  LIMIT 10
```

2. Get details for a specific tag:
```sql
SELECT
    id,
    tag_name,
    count,
    excerpt_post_id,
    wiki_post_id
  FROM
    `bigquery-public-data.stackoverflow.tags`
  WHERE
    tag_name = \'python\'
```

3. Join with posts to find posts related to a popular tag (example uses `posts_questions` which is related to `stackoverflow_posts`):
```sql
SELECT
    p.title,
    t.tag_name
  FROM
    `bigquery-public-data.stackoverflow.posts_questions` AS p,
    `bigquery-public-data.stackoverflow.tags` AS t
  WHERE
    p.tags LIKE CONCAT(\'%<\', t.tag_name, \'>%\' )
    AND t.tag_name = \'javascript\'
  LIMIT 5
```

# Citations
[1] [BigQuery Public Dataset: Stack Overflow Tags](https://bigquery.googleapis.com/v2/projects/bigquery-public-data/datasets/stackoverflow/tables/tags)
[2] [Stack Overflow Dataset on BigQuery](https://console.cloud.google.com/marketplace/details/stackoverflow/stackoverflow)
[3] [Database schema documentation for the public data dump and SEDE](https://meta.stackexchange.com/questions/2677/database-schema-documentation-for-the-public-data-dump-and-sede)
