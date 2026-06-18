# users

Source: Stack Exchange Data Dump / SEDE — Users

`users` holds one row per Stack Overflow account.

## Columns
- `id` — the user's unique id (primary key).
- `display_name` — the user's public name.
- `reputation` — the user's earned reputation, the site's core trust score.
- `creation_date`, `last_access_date` — account timestamps.
- `up_votes` / `down_votes` — counts of votes this user has cast.
- `location`, `about_me`, `views` — profile fields.

(This table is a parent/lookup entity. It documents only its own columns.)

---
*Source: SEDE Users — factual.*
