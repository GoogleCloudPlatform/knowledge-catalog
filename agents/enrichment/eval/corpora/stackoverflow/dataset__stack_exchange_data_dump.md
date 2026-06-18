# Stack Overflow public dataset (overview & entity graph)

Source: `bigquery-public-data.stackoverflow`
Source: Stack Exchange Data Dump / SEDE schema —
https://meta.stackexchange.com/questions/2677/database-schema-documentation-for-the-public-data-dump-and-sede
Source: Stack Exchange Data Explorer help — https://data.stackexchange.com/help

## What this dataset is

A BigQuery mirror of the **Stack Exchange Data Dump** for **Stack Overflow** — the
public Q&A site for programmers. Unlike GA4 (one denormalized events table) or
Bitcoin (a few tightly-coupled fact tables), Stack Overflow is a set of **many
independent entity tables** that join through integer ids, so a single schema-docs
page often describes several tables at once.

## The core entities and how they relate

- **`posts_questions`** — one row per question.
- **`posts_answers`** — one row per answer; `parent_id` → `posts_questions.id`.
- **`users`** — one row per user; posts/comments/votes/badges reference
  `users.id` via `owner_user_id` / `user_id`.
- **`comments`** — one row per comment; `post_id` → a question or answer,
  `user_id` → `users.id`.
- **`votes`** — one row per vote on a post; `post_id` → a post,
  `vote_type_id` encodes the kind (e.g. up, down, accept).
- **`tags`** — one row per tag (a topic label); `count` is how many questions use it.
- **`badges`** — one row per badge award; `user_id` → `users.id`.

## The relationship web (foreign keys in prose)

- A question's accepted answer: `posts_questions.accepted_answer_id` →
  `posts_answers.id`.
- An answer's question: `posts_answers.parent_id` → `posts_questions.id`.
- Authorship: `posts_questions.owner_user_id` / `posts_answers.owner_user_id` →
  `users.id`.
- Engagement: `votes.post_id` and `comments.post_id` point at a post (question or
  answer); `comments.user_id` and `badges.user_id` point at `users.id`.
- Topics: questions carry a `tags` field (a list of tag names) that corresponds to
  rows in `tags`.

These integer-id joins are the canonical analytical paths (e.g. top answerers,
acceptance rate by tag, reputation vs. activity).

---
*Source: Stack Exchange Data Dump / SEDE schema documentation — factual.*
