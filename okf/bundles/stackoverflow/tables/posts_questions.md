---
type: BigQuery Table
resource: https://bigquery.googleapis.com/v2/projects/bigquery-public-data/datasets/stackoverflow/tables/posts_questions
title: Stack Overflow Questions
description: This table contains information about all question posts on Stack Overflow,
  including detailed schema fields, their descriptions, and licensing information.
tags:
- Stack Overflow
- questions
- posts
- programming
- community
- schema
- data dump
timestamp: '2026-05-28T23:31:54+00:00'
---

This table, part of the public [Stack Overflow dataset](../datasets/stackoverflow.md), contains comprehensive data for every question asked on the Stack Overflow platform. Each row represents a unique question post, including its content, metadata such as creation and last activity dates, view counts, and score. It serves as a primary resource for analyzing user activity, popular topics, and the overall dynamics of the Q&A community. The table can be joined with other tables like [posts_answers](posts_answers.md) to link questions to their corresponding answers, or with [users](users.md) to retrieve information about the question\'s author.

# Schema
The schema contains fields related to the question\'s content, status, and associated user data. Key fields include `id` for unique identification, `title` and `body` for the question\'s content, `creation_date` for when the question was posted, and `tags` for categorizing the question.

- `id` (INTEGER) - Unique identifier for the post.
- `title` (STRING) - The title of the question (for `PostTypeId = 1`).
- `body` (STRING) - The body of the post, as rendered HTML, not Markdown.
- `accepted_answer_id` (INTEGER) - The ID of the accepted answer; present only if `PostTypeId = 1`.
- `answer_count` (INTEGER) - The number of undeleted answers; present only if `PostTypeId = 1`.
- `closed_date` (TIMESTAMP) - The date and time the post was closed; present only if the post is closed.
- `comment_count` (INTEGER) - The number of comments.
- `community_owned_date` (TIMESTAMP) - The date and time the post became community wiki\'d.
- `creation_date` (TIMESTAMP) - The date and time the post was created.
- `favorite_count` (INTEGER) - The number of times the post has been favorited. Nullable.
- `last_activity_date` (TIMESTAMP) - The datetime of the post\'s most recent activity.
- `last_edit_date` (TIMESTAMP) - The date and time of the most recent edit to the post.
- `last_editor_display_name` (STRING) - The display name of the last editor. Nullable.
- `last_editor_user_id` (INTEGER) - The ID of the last editor user. Nullable.
- `owner_display_name` (STRING) - The display name of the post owner. Nullable.
- `owner_user_id` (INTEGER) - The ID of the post owner. Present only if user has not been deleted; always -1 for tag wiki entries.
- `parent_id` (STRING) - Parent ID. For questions (`PostTypeId = 1`), this field is typically NULL. It is mainly used for answers (`PostTypeId = 2`) to link to their parent question.
- `post_type_id` (INTEGER) - The type of the post. For questions, this is `1`. See the [Post Type IDs reference](../references/post_type_ids.md) for possible values.
- `score` (INTEGER) - The score of the post; generally non-zero for Questions, Answers, and Moderator Nominations.
- `tags` (STRING) - The tags associated with the question (for `PostTypeId = 1`).
- `view_count` (INTEGER) - The number of times the post has been viewed. Nullable.
- `content_license` (STRING) - Indicates the Creative Commons license under which the content is licensed.

# Common query patterns
1. **Find the most viewed questions in a specific tag:**
   ```sql
   SELECT
     title,
     view_count
   FROM
     `bigquery-public-data.stackoverflow.posts_questions`
   WHERE
     tags LIKE \'%<your-tag>%'
   ORDER BY
     view_count DESC
   LIMIT 10
   ```
2. **Count questions posted per year:**
   ```sql
   SELECT
     EXTRACT(YEAR FROM creation_date) AS year,
     COUNT(id) AS question_count
   FROM
     `bigquery-public-data.stackoverflow.posts_questions`
   GROUP BY
     year
   ORDER BY
     year DESC
   ```
3. **Get questions with accepted answers and their answer count:**
   ```sql
   SELECT
     id,
     title,
     accepted_answer_id,
     answer_count
   FROM
     `bigquery-public-data.stackoverflow.posts_questions`
   WHERE
     accepted_answer_id IS NOT NULL
   ORDER BY
     answer_count DESC
   LIMIT 5
   ```

# Citations
[1] [posts_questions](https://bigquery.googleapis.com/v2/projects/bigquery-public-data/datasets/stackoverflow/tables/posts_questions)
[2] [Database schema documentation for the public data dump and SEDE](https://meta.stackexchange.com/questions/2677/database-schema-documentation-for-the-public-data-dump-and-sede)
