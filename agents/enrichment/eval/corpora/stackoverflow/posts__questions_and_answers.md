# `posts_questions` and `posts_answers`

Source: Stack Exchange Data Dump / SEDE — Posts table documentation
Source: `bigquery-public-data.stackoverflow.posts_questions` / `.posts_answers`

In the upstream dump questions and answers share one `Posts` table distinguished
by `PostTypeId` (1 = question, 2 = answer); the BigQuery export splits them into
two tables with aligned schemas.

## `posts_questions` (one row per question)

- **`id`** — the question's unique id (primary key).
- **`title`**, **`body`** — the question title and HTML body.
- **`tags`** — the question's topic labels (a delimited list of tag names that
  correspond to rows in `tags`).
- **`owner_user_id`** → `users.id` — the asker.
- **`accepted_answer_id`** → `posts_answers.id` — the answer the asker accepted
  (null if none).
- **`answer_count`**, **`comment_count`**, **`view_count`**, **`score`** —
  engagement counters; `score` is upvotes minus downvotes.
- **`creation_date`**, **`last_activity_date`** — timestamps.

## `posts_answers` (one row per answer)

- **`id`** — the answer's unique id (primary key).
- **`parent_id`** → `posts_questions.id` — the question this answer responds to.
- **`owner_user_id`** → `users.id` — the answerer.
- **`body`**, **`score`**, **`comment_count`**, **`creation_date`** — content,
  net votes, and timestamps.

## Relationships

`posts_answers.parent_id` joins answers back to their question; a question's
`accepted_answer_id` points to exactly one row in `posts_answers`. Both tables'
`owner_user_id` join to `users`. Comments and votes attach to either via
`post_id`. Canonical questions: acceptance rate, time-to-first-answer, and top
answerers per tag.

---
*Source: Stack Exchange Data Dump (Posts) — factual.*
