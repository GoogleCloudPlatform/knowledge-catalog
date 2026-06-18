# badges

Source: Stack Exchange Data Dump / SEDE — Badges

`badges` holds one row per badge awarded to a user.

## Columns
- `id` — badge id (primary key).
- `user_id` — FK: references `users.id` (the recipient).
- `name`, `date`, `class` (1=gold, 2=silver, 3=bronze), `tag_based`.

## Relationships (documented from this table)
- `badges.user_id` → `users.id`.

---
*Source: SEDE Badges — factual.*
