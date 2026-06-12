---
type: BigQuery Table
resource: https://bigquery.googleapis.com/v2/projects/bigquery-public-data/datasets/stackoverflow/tables/posts_tag_wiki_excerpt
title: Posts Tag Wiki Excerpt
description: Contains excerpts from tag wikis on Stack Overflow.
tags: stackoverflow, posts, tags, wiki, excerpt
timestamp: '2026-05-28T23:29:18+00:00'
---

The `posts_tag_wiki_excerpt` table in the BigQuery Stack Overflow public dataset contains summary information, or excerpts, from the wiki pages associated with various tags. Each row represents a single tag wiki excerpt, providing details such as the excerpt's body, its associated tag, and metadata about its creation and last modification. This table is useful for understanding the brief descriptions provided for tags on the Stack Overflow platform, offering quick insights into what a particular tag represents.

# Schema
- `id`: Unique identifier for the tag wiki excerpt.
- `title`: Title of the tag wiki excerpt.
- `body`: The content of the tag wiki excerpt.
- `accepted_answer_id`: (STRING)
- `answer_count`: (STRING)
- `comment_count`: Number of comments on the excerpt.
- `community_owned_date`: When the excerpt became community-owned.
- `creation_date`: When the excerpt was created.
- `favorite_count`: (STRING)
- `last_activity_date`: Last activity date on the excerpt.
- `last_edit_date`: Last edit date of the excerpt.
- `last_editor_display_name`: Display name of the last editor.
- `last_editor_user_id`: User ID of the last editor.
- `owner_display_name`: Display name of the owner.
- `owner_user_id`: User ID of the owner.
- `parent_id`: (STRING)
- `post_type_id`: Type of post.
- `score`: Score of the excerpt.
- `tags`: The tag associated with this wiki excerpt (e.g., `<python>`).
- `view_count`: (STRING)

# Common query patterns

```sql
SELECT
    title,
    body
  FROM
    `bigquery-public-data.stackoverflow.posts_tag_wiki_excerpt`
  WHERE
    id = 12345
```

```sql
SELECT
    title,
    tags
  FROM
    `bigquery-public-data.stackoverflow.posts_tag_wiki_excerpt`
  WHERE
    body LIKE '%python%'
```

```sql
SELECT
    title,
    creation_date,
    last_editor_display_name
  FROM
    `bigquery-public-data.stackoverflow.posts_tag_wiki_excerpt`
  ORDER BY
    creation_date DESC
  LIMIT 10
```

# Citations
[1] [BigQuery Public Data: Stack Overflow posts_tag_wiki_excerpt](https://bigquery.googleapis.com/v2/projects/bigquery-public-data/datasets/stackoverflow/tables/posts_tag_wiki_excerpt)
