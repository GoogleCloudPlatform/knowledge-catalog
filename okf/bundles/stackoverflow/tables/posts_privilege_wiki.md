---
type: BigQuery Table
resource: https://bigquery.googleapis.com/v2/projects/bigquery-public-data/datasets/stackoverflow/tables/posts_privilege_wiki
title: Posts Privilege Wiki
description: This table contains posts describing various privileges on Stack Overflow,
  such as editing questions and retagging.
tags: stackoverflow, posts, wiki, privileges, community, documentation
timestamp: '2026-05-28T23:28:24+00:00'
---

This BigQuery table, `posts_privilege_wiki`, contains posts that describe various user privileges within the Stack Overflow community. These entries serve as informational guides, explaining what a privilege entails, when and how to use it, and related community guidelines. Examples include details on editing questions and answers, or the process of retagging questions. Each row represents a specific privilege explanation, detailing its purpose and usage, contributing to the self-documentation of the platform's community features.

# Schema
- `id`: Unique identifier for the post.
- `title`: The title of the post. For these privilege wiki entries, titles are often null, with the main content in the body.
- `body`: The full content of the privilege explanation, often including HTML formatting.
- `accepted_answer_id`: (Always null for these types of posts)
- `answer_count`: (Always null for these types of posts)
- `comment_count`: Number of comments on the post.
- `community_owned_date`: Date when the post became community-owned.
- `creation_date`: Timestamp when the post was created.
- `favorite_count`: (Always null for these types of posts)
- `last_activity_date`: Timestamp of the last activity on the post.
- `last_edit_date`: Timestamp of the last edit to the post.
- `last_editor_display_name`: Display name of the last user who edited the post.
- `last_editor_user_id`: User ID of the last user who edited the post.
- `owner_display_name`: Display name of the post's owner.
- `owner_user_id`: User ID of the post's owner. Often -1 for community posts.
- `parent_id`: (Always null for these types of posts)
- `post_type_id`: Type of post, typically 8 for wiki entries.
- `score`: The score (upvotes minus downvotes) of the post.
- `tags`: (Always null for these types of posts)
- `view_count`: (Always null for these types of posts)

# Common query patterns
```sql
SELECT
  id,
  body
FROM
  `bigquery-public-data.stackoverflow.posts_privilege_wiki`
WHERE
  creation_date >= '2013-01-01'
LIMIT 100
```
```sql
SELECT
  id,
  body,
  creation_date
FROM
  `bigquery-public-data.stackoverflow.posts_privilege_wiki`
WHERE
  body LIKE '%edit questions and answers%'
```

# Citations
[1] [BigQuery Public Dataset: Stack Overflow Posts Privilege Wiki](https://bigquery.googleapis.com/v2/projects/bigquery-public-data/datasets/stackoverflow/tables/posts_privilege_wiki)
