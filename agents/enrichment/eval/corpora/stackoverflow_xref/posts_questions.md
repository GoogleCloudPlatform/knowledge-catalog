# posts_questions

Source: Stack Exchange Data Dump / SEDE — Posts (questions)

`posts_questions` holds one row per question.

## Columns
- `id` — the question's unique id (primary key).
- `title`, `body` — the question text.
- `tags` — the question's topic labels.
- `owner_user_id` — FK: references `users.id` (the asker).
- `accepted_answer_id` — FK: references `posts_answers.id` (the accepted answer, null if none).
- `score`, `answer_count`, `view_count`, `creation_date`.

## Relationships (documented from this table)
- `posts_questions.owner_user_id` → `users.id`.
- `posts_questions.accepted_answer_id` → `posts_answers.id`.

---
*Source: SEDE Posts — factual.*
