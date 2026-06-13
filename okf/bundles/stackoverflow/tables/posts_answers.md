---
type: BigQuery Table
resource: https://bigquery.googleapis.com/v2/projects/bigquery-public-data/datasets/stackoverflow/tables/posts_answers
title: Posts Answers
description: Contains information about answers to questions posted on Stack Overflow,
  including detailed schema fields, their descriptions, and licensing information.
tags:
- stackoverflow
- posts
- answers
- community
- programming
- schema
- data dump
timestamp: '2026-05-28T23:32:11+00:00'
---

The `posts_answers` table in the [stackoverflow](../datasets/stackoverflow.md) dataset contains all posts identified as answers to questions on the Stack Overflow platform. Each row in this table represents a single answer, providing details such as the answer\'s body, its score, creation date, and the ID of the parent question it answers. This table can be joined with other tables like [posts_questions](posts_questions.md) on `parent_id` to link answers to their respective questions. It\'s a valuable resource for analyzing answer quality, user contributions, and engagement patterns within the Stack Overflow community.

# Schema
- `id` (INTEGER) - Unique identifier for the answer.
- `title` (STRING) - The title of the post. This is typically NULL for answers.
- `body` (STRING) - The body of the post, as rendered HTML, not Markdown.
- `accepted_answer_id` (INTEGER) - The ID of the answer that was accepted for a question. This field is only applicable to questions, so it is typically NULL for answers.
- `answer_count` (INTEGER) - The number of answers. This field is only applicable to questions, so it is typically NULL for answers.
- `closed_date` (TIMESTAMP) - The date and time the post was closed; present only if the post is closed. This is typically NULL for answers.
- `comment_count` (INTEGER) - The number of comments.
- `community_owned_date` (TIMESTAMP) - The date and time the post became community wiki\'d.
- `creation_date` (TIMESTAMP) - The date and time the answer was created.
- `favorite_count` (INTEGER) - The number of times the post has been favorited. Nullable. This is typically NULL for answers.
- `last_activity_date` (TIMESTAMP) - The datetime of the post\'s most recent activity.
- `last_edit_date` (TIMESTAMP) - The date and time of the most recent edit to the answer.
- `last_editor_display_name` (STRING) - The display name of the last editor. Nullable.
- `last_editor_user_id` (INTEGER) - The ID of the last editor user. Nullable.
- `owner_display_name` (STRING) - The display name of the answer\'s owner. Nullable.
- `owner_user_id` (INTEGER) - The ID of the answer\'s owner. Present only if user has not been deleted.
- `parent_id` (INTEGER) - The ID of the question this answer belongs to. Present only if `PostTypeId = 2`.
- `post_type_id` (INTEGER) - The type of post. For answers, this is `2`. See the [Post Type IDs reference](../references/post_type_ids.md) for possible values.
- `score` (INTEGER) - The score of the answer; generally non-zero for Questions, Answers, and Moderator Nominations.
- `tags` (STRING) - Tags associated with the post. This is typically NULL for answers, as tags are associated with the parent question.
- `view_count` (INTEGER) - The number of times the post was viewed. This field is only applicable to questions, so it is typically NULL for answers.
- `content_license` (STRING) - Indicates the Creative Commons license under which the content is licensed.

# Common query patterns
1. Get the 10 most highly-scored answers in a specific date range:
```sql
SELECT
  id,
  score,
  creation_date,
  body
FROM
  `bigquery-public-data.stackoverflow.posts_answers`
WHERE
  creation_date BETWEEN \'2023-01-01\' AND \'2023-01-31\'
ORDER BY
  score DESC
LIMIT 10
```
2. Find the total number of answers by a specific user:
```sql
SELECT
  owner_user_id,
  COUNT(id) AS total_answers
FROM
  `bigquery-public-data.stackoverflow.posts_answers`
WHERE
  owner_user_id = 12345 -- Replace with a valid user ID
GROUP BY
  owner_user_id
```
3. Join answers with their corresponding questions:
```sql
SELECT
  q.title AS question_title,
  a.body AS answer_body,
  a.score AS answer_score
FROM
  `bigquery-public-data.stackoverflow.posts_answers` AS a
JOIN
  `bigquery-public-data.stackoverflow.posts_questions` AS q
ON
  a.parent_id = q.id
WHERE
  q.id = 5000 -- Example question ID
```

# Citations
[1] [Stack Overflow Posts Answers Table](https://bigquery.googleapis.com/v2/projects/bigquery-public-data/datasets/stackoverflow/tables/posts_answers)
[2] [Stack Overflow Public Data Explorer](https://data.stackexchange.com/)
[3] [Database schema documentation for the public data dump and SEDE](https://meta.stackexchange.com/questions/2677/database-schema-documentation-for-the-public-data-dump-and-sede)
