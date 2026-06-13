---
type: BigQuery Table
resource: https://bigquery.googleapis.com/v2/projects/bigquery-public-data/datasets/stackoverflow/tables/posts_tag_wiki
title: Posts Tag Wiki
description: Contains detailed wiki descriptions for tags on Stack Overflow.
tags: stackoverflow, tag, wiki, posts, bigquery
timestamp: '2026-05-28T23:29:03+00:00'
---

The `posts_tag_wiki` table in the BigQuery Stack Overflow dataset stores detailed wiki descriptions for various [tags](tags.md) used on the platform. Each row represents a wiki entry associated with a specific tag, providing comprehensive information about its purpose, usage, and related concepts. This table is useful for understanding the context and definition of tags, which helps in categorizing questions and answers accurately. The `body` field contains the rich text content of the wiki. This table is a valuable resource for anyone analyzing the structure and content organization of [Stack Overflow](../datasets/stackoverflow.md). The grain of this table is one row per tag wiki entry.

# Schema
- `id`: INTEGER, Unique identifier for the tag wiki post.
- `title`: STRING, Title of the tag wiki (often null for actual tag wiki posts).
- `body`: STRING, The main content of the tag wiki, containing detailed description.
- `accepted_answer_id`: STRING, ID of the accepted answer, if applicable.
- `answer_count`: STRING, Number of answers.
- `comment_count`: INTEGER, Number of comments on the post.
- `community_owned_date`: TIMESTAMP, Date when the post became community-owned.
- `creation_date`: TIMESTAMP, Date and time the post was created.
- `favorite_count`: STRING, Number of times the post has been favorited.
- `last_activity_date`: TIMESTAMP, Date and time of the last activity on the post.
- `last_edit_date`: TIMESTAMP, Date and time of the last edit to the post.
- `last_editor_display_name`: STRING, Display name of the last editor.
- `last_editor_user_id`: INTEGER, User ID of the last editor.
- `owner_display_name`: STRING, Display name of the post owner.
- `owner_user_id`: INTEGER, User ID of the post owner.
- `parent_id`: STRING, ID of the parent post, if applicable.
- `post_type_id`: INTEGER, Identifier for the type of post (e.g., 5 for Tag Wiki).
- `score`: INTEGER, The score of the post.
- `tags`: STRING, Tags associated with the post (usually null for tag wiki posts, as the wiki *is* for a tag).
- `view_count`: STRING, Number of views the post has received.

# Common query patterns

To retrieve the body of a specific tag wiki:
```sql
SELECT
    body
  FROM
    `bigquery-public-data.stackoverflow.posts_tag_wiki`
  WHERE
    id = 5046395
```

To find tag wiki entries created after a certain date:
```sql
SELECT
    id,
    creation_date,
    body
  FROM
    `bigquery-public-data.stackoverflow.posts_tag_wiki`
  WHERE
    creation_date > '2020-01-01'
  LIMIT 100
```

To count the number of tag wiki entries per creation year:
```sql
SELECT
    EXTRACT(YEAR FROM creation_date) AS creation_year,
    COUNT(id) AS number_of_wikis
  FROM
    `bigquery-public-data.stackoverflow.posts_tag_wiki`
  GROUP BY
    creation_year
  ORDER BY
    creation_year DESC
```

# Citations
[1] [BigQuery Public Dataset: Stack Overflow Posts Tag Wiki](https://bigquery.googleapis.com/v2/projects/bigquery-public-data/datasets/stackoverflow/tables/posts_tag_wiki)
