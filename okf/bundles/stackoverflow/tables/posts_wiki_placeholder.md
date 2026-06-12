---
type: BigQuery Table
resource: https://bigquery.googleapis.com/v2/projects/bigquery-public-data/datasets/stackoverflow/tables/posts_wiki_placeholder
title: Posts Wiki Placeholder
description: Placeholder table for Stack Overflow wiki posts, containing community-maintained
  help and information.
tags: stackoverflow, posts, wiki, help, community, documentation
timestamp: '2026-05-28T23:29:41+00:00'
---

This table serves as a placeholder for various wiki posts within the Stack Overflow community, containing community-maintained help, guidelines, and other informational content. Each row in this table represents a single wiki post, identified by a unique `id`. These posts often include details about election processes, help center articles, and general community guidelines.

# Schema

- `id`: INTEGER, Unique identifier for the wiki post.
- `title`: STRING, Title of the wiki post.
- `body`: STRING, The main content of the wiki post.
- `accepted_answer_id`: STRING
- `answer_count`: STRING
- `comment_count`: INTEGER, Number of comments on the post.
- `community_owned_date`: STRING
- `creation_date`: TIMESTAMP, Timestamp when the post was created.
- `favorite_count`: STRING
- `last_activity_date`: TIMESTAMP, Timestamp of the last activity on the post.
- `last_edit_date`: TIMESTAMP, Timestamp when the post was last edited.
- `last_editor_display_name`: STRING
- `last_editor_user_id`: INTEGER, User ID of the last editor.
- `owner_display_name`: STRING
- `owner_user_id`: INTEGER, User ID of the post owner.
- `parent_id`: STRING
- `post_type_id`: INTEGER, Type of the post (e.g., 7 for Wiki).
- `score`: INTEGER, Score of the post.
- `tags`: STRING, Tags associated with the post.
- `view_count`: STRING

# Common query patterns

```sql
SELECT
    id, title, body
  FROM
    `bigquery-public-data.stackoverflow.posts_wiki_placeholder`
  WHERE
    id = 8041931
```

```sql
SELECT
    id, title
  FROM
    `bigquery-public-data.stackoverflow.posts_wiki_placeholder`
  WHERE
    body LIKE '%election process%'
  LIMIT 100
```

```sql
SELECT
    EXTRACT(YEAR FROM creation_date) AS creation_year,
    COUNT(id) AS post_count
  FROM
    `bigquery-public-data.stackoverflow.posts_wiki_placeholder`
  GROUP BY
    creation_year
  ORDER BY
    creation_year DESC
```

# Citations

[1] [BigQuery Public Data: Stack Overflow posts_wiki_placeholder](https://bigquery.googleapis.com/v2/projects/bigquery-public-data/datasets/stackoverflow/tables/posts_wiki_placeholder)
