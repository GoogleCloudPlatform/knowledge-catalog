# posts_answers

Source: Stack Exchange Data Dump / SEDE — Posts (answers)

`posts_answers` holds one row per answer.

## Columns
- `id` — the answer's unique id (primary key).
- `parent_id` — FK: references `posts_questions.id` (the question this answers).
- `owner_user_id` — FK: references `users.id` (the answerer).
- `body`, `score`, `comment_count`, `creation_date`.

## Relationships (documented from this table)
- `posts_answers.parent_id` → `posts_questions.id`.
- `posts_answers.owner_user_id` → `users.id`.

---
*Source: SEDE Posts — factual.*
