# comments

Source: Stack Exchange Data Dump / SEDE — Comments

`comments` holds one row per comment on a post.

## Columns
- `id` — comment id (primary key).
- `post_id` — FK: references a post (`posts_questions.id` or `posts_answers.id`).
- `user_id` — FK: references `users.id` (the commenter).
- `text`, `score`, `creation_date`.

## Relationships (documented from this table)
- `comments.post_id` → a post; `comments.user_id` → `users.id`.

---
*Source: SEDE Comments — factual.*
