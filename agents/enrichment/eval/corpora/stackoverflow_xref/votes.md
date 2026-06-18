# votes

Source: Stack Exchange Data Dump / SEDE — Votes

`votes` holds one row per vote cast on a post.

## Columns
- `id` — vote id (primary key).
- `post_id` — FK: references a post (`posts_questions.id` or `posts_answers.id`).
- `vote_type_id` — the kind of vote: 2 = upvote, 3 = downvote, 1 = accepted.
- `creation_date`.

## Relationships (documented from this table)
- `votes.post_id` → a post (`posts_questions` / `posts_answers`).
- Votes are anonymous: the table has no user id.

---
*Source: SEDE Votes — factual.*
