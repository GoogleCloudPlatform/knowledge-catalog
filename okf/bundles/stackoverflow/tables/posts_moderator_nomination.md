---
type: BigQuery Table
resource: https://bigquery.googleapis.com/v2/projects/bigquery-public-data/datasets/stackoverflow/tables/posts_moderator_nomination
title: Posts Moderator Nomination
description: Contains posts where users nominate themselves or others to become moderators
  on the Stack Overflow platform.
tags: stackoverflow, posts, moderator, nomination
timestamp: '2026-05-28T23:27:37+00:00'
---

This table contains posts submitted by users nominating themselves or others to become moderators on the Stack Overflow platform. Each row represents a single moderator nomination post, detailing the candidate's qualifications or reasons for nomination.

The `creation_date` field indicates when the nomination post was created, providing a historical record of moderator elections and community engagement.

# Schema

- `id`: Unique identifier for the post.
- `title`: Title of the nomination post (often null for this post type).
- `body`: The content of the nomination post, describing the candidate's qualifications.
- `accepted_answer_id`: (STRING) ID of the accepted answer, if applicable.
- `answer_count`: (STRING) Number of answers to the post.
- `comment_count`: Number of comments on the post.
- `community_owned_date`: Timestamp when the post became community-owned.
- `creation_date`: Timestamp when the post was created.
- `favorite_count`: (STRING) Number of times the post has been favorited.
- `last_activity_date`: Timestamp of the last activity on the post.
- `last_edit_date`: Timestamp of the last edit to the post.
- `last_editor_display_name`: Display name of the last editor.
- `last_editor_user_id`: User ID of the last editor.
- `owner_display_name`: Display name of the post owner.
- `owner_user_id`: User ID of the post owner. This links to the [/users](users.md) table.
- `parent_id`: (STRING) ID of the parent post, if this is a reply.
- `post_type_id`: Type of the post (e.g., 6 for moderator nomination).
- `score`: The score of the post.
- `tags`: (STRING) Tags associated with the post.
- `view_count`: (STRING) Number of views the post has received.

# Common query patterns

```sql
SELECT
    id,
    creation_date,
    owner_user_id,
    body
  FROM
    `bigquery-public-data.stackoverflow.posts_moderator_nomination`
  WHERE
    creation_date BETWEEN '2021-01-01' AND '2021-12-31'
  ORDER BY
    creation_date DESC
  LIMIT 100
```

```sql
SELECT
    p.id,
    p.creation_date,
    u.display_name AS nominator_name,
    p.body
  FROM
    `bigquery-public-data.stackoverflow.posts_moderator_nomination` AS p
  JOIN
    `bigquery-public-data.stackoverflow.users` AS u
    ON p.owner_user_id = u.id
  WHERE
    p.creation_date >= '2022-01-01'
  LIMIT 10
```

# Citations

[1] [BigQuery Public Data: Stack Overflow Posts Moderator Nomination](https://bigquery.googleapis.com/v2/projects/bigquery-public-data/datasets/stackoverflow/tables/posts_moderator_nomination)
