# `users`, `votes`, `comments`, `tags`, `badges`

Source: Stack Exchange Data Dump / SEDE — Users / Votes / Comments / Tags / Badges
Source: `bigquery-public-data.stackoverflow` schema

## `users` (one row per account)

- **`id`** — user id (primary key); referenced by posts/comments/votes/badges.
- **`display_name`**, **`location`**, **`about_me`**, **`creation_date`**,
  **`last_access_date`**.
- **`reputation`** — the user's earned reputation (the site's core trust score);
  **`up_votes`** / **`down_votes`** cast, **`views`** of the profile.

## `votes` (one row per vote on a post)

- **`id`**, **`post_id`** → a post (question or answer), **`creation_date`**.
- **`vote_type_id`** — the kind of vote, e.g. `1` = AcceptedByOriginator,
  `2` = UpMod (upvote), `3` = DownMod (downvote). Votes are anonymous (no user id).

## `comments` (one row per comment)

- **`id`**, **`post_id`** → a post, **`user_id`** → `users.id`, **`text`**,
  **`score`**, **`creation_date`**.

## `tags` (one row per topic label)

- **`id`**, **`tag_name`** — the tag (e.g. `python`, `sql`).
- **`count`** — the number of questions tagged with it.
- **`excerpt_post_id`** / **`wiki_post_id`** → the tag's wiki excerpt / wiki posts.

## `badges` (one row per badge award)

- **`id`**, **`user_id`** → `users.id`, **`name`**, **`date`**.
- **`class`** — `1` = gold, `2` = silver, `3` = bronze.
- **`tag_based`** — whether the badge was earned for activity on a specific tag.

## Relationships

`votes.post_id` and `comments.post_id` attach engagement to questions/answers;
`comments.user_id` and `badges.user_id` attach to `users`; `users.reputation` is
driven by the votes a user's posts receive. `tags.count` aggregates the questions
carrying each tag. Canonical questions: reputation leaders, badge distribution by
class, and most-used tags.

---
*Source: Stack Exchange Data Dump (Users/Votes/Comments/Tags/Badges) — factual.*
