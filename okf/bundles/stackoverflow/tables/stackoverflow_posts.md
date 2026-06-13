---
type: BigQuery Table
resource: https://bigquery.googleapis.com/v2/projects/bigquery-public-data/datasets/stackoverflow/tables/stackoverflow_posts
title: Stack Overflow Posts (Legacy)
description: A legacy table containing all posts from Stack Overflow. This table is
  deprecated; use `posts_answers`, `posts_questions`, or other `posts_*` tables instead.
tags: Stack Overflow, posts, legacy, deprecated
timestamp: '2026-05-28T23:30:00+00:00'
---

This table, `stackoverflow_posts`, is a legacy table from the [stackoverflow](../datasets/stackoverflow.md) dataset in Google Cloud's BigQuery public datasets. It contains all posts (questions and answers) from Stack Overflow. **This table is deprecated and should not be used for new queries.** Users are advised to use the more specific and updated tables like [posts_questions](posts_questions.md) for questions and [posts_answers](posts_answers.md) for answers. Each row in this table represents a single post, with fields such as `id`, `title`, `body`, `creation_date`, and user information. The table contains approximately 31 million rows and over 31 GB of data.

# Schema

- `id`: Unique identifier for the post.
- `title`: The title of the post (for questions).
- `body`: The main content of the post.
- `accepted_answer_id`: The ID of the accepted answer (for questions).
- `answer_count`: Number of answers for a question.
- `comment_count`: Number of comments on the post.
- `community_owned_date`: Timestamp when the post became community-owned.
- `creation_date`: Timestamp when the post was created.
- `favorite_count`: Number of times the post has been favorited.
- `last_activity_date`: Timestamp of the last activity on the post.
- `last_edit_date`: Timestamp of the last edit.
- `last_editor_display_name`: Display name of the last editor.
- `last_editor_user_id`: User ID of the last editor.
- `owner_display_name`: Display name of the post owner.
- `owner_user_id`: User ID of the post owner.
- `parent_id`: For answers, the ID of the question it answers.
- `post_type_id`: Type of the post (e.g., 1 for question, 2 for answer).
- `score`: The score of the post (upvotes - downvotes).
- `tags`: Comma-separated tags associated with the post (for questions).
- `view_count`: Number of views for the post (for questions).

# Common query patterns

```sql
SELECT
  id,
  title,
  creation_date
FROM
  `bigquery-public-data.stackoverflow.stackoverflow_posts`
WHERE
  creation_date BETWEEN '2008-01-01' AND '2008-01-31'
  AND post_type_id = 1 -- Questions only
LIMIT 100;
```

# Citations

[1] [BigQuery Console - stackoverflow_posts](https://bigquery.googleapis.com/v2/projects/bigquery-public-data/datasets/stackoverflow/tables/stackoverflow_posts)
[2] [BigQuery Public Datasets - Stack Overflow](https://cloud.google.com/bigquery/public-data/stackoverflow)
