---
type: BigQuery Table
resource: https://bigquery.googleapis.com/v2/projects/bigquery-public-data/datasets/stackoverflow/tables/posts_orphaned_tag_wiki
title: Orphaned Tag Wiki Posts
description: This table contains Tag Wiki posts that are no longer associated with
  an active tag on Stack Overflow.
tags: stackoverflow, posts, tag, wiki, orphaned
timestamp: '2026-05-28T23:27:56+00:00'
---

This table, part of the public [Stack Overflow dataset](../datasets/stackoverflow.md), contains posts that were originally created as Tag Wikis but are no longer linked to an existing tag within the Stack Overflow platform. These 'orphaned' Tag Wiki entries typically describe the purpose and usage of a specific programming language, technology, or concept. Each row represents a single Tag Wiki post, identified by a unique `id`. The `post_type_id` for these entries is typically `3`. The table includes the body of the wiki, creation dates, and metadata about the last editor and activity. It can be used to analyze historical Tag Wiki content that has become disassociated from its original tag.

# Schema

- `id`: Unique identifier for the post.
- `title`: Title of the post (often null for Tag Wikis).
- `body`: The main content of the Tag Wiki, often including HTML.
- `accepted_answer_id`: (Always null for this post type).
- `answer_count`: (Always null for this post type).
- `comment_count`: Number of comments on the post.
- `community_owned_date`: Timestamp when the post became community-owned.
- `creation_date`: Timestamp when the post was created.
- `favorite_count`: Number of times the post has been favorited.
- `last_activity_date`: Timestamp of the last activity on the post.
- `last_edit_date`: Timestamp of the last edit to the post.
- `last_editor_display_name`: Display name of the last user to edit the post.
- `last_editor_user_id`: User ID of the last user to edit the post.
- `owner_display_name`: Display name of the user who owns the post.
- `owner_user_id`: User ID of the user who owns the post.
- `parent_id`: (Always null for this post type).
- `post_type_id`: Type of the post. For this table, it's typically `3` (Tag Wiki).
- `score`: The score of the post.
- `tags`: Tags associated with the post (often null as these are orphaned).
- `view_count`: Number of times the post has been viewed.

# Common query patterns

```sql
SELECT
    id,
    creation_date,
    body
  FROM
    `bigquery-public-data.stackoverflow.posts_orphaned_tag_wiki`
  WHERE
    creation_date < '2015-01-01'
  LIMIT 100;
```

```sql
SELECT
    id,
    body
  FROM
    `bigquery-public-data.stackoverflow.posts_orphaned_tag_wiki`
  WHERE
    id = 4164933;
```

```sql
SELECT
    count(id) AS total_orphaned_tag_wikis
  FROM
    `bigquery-public-data.stackoverflow.posts_orphaned_tag_wiki`;
```

# Citations

[1] [BigQuery Public Data: Stack Overflow posts_orphaned_tag_wiki](https://bigquery.googleapis.com/v2/projects/bigquery-public-data/datasets/stackoverflow/tables/posts_orphaned_tag_wiki)
[2] [Stack Overflow](https://stackoverflow.com/)
