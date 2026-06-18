# tags

Source: Stack Exchange Data Dump / SEDE — Tags

`tags` holds one row per topic label.

## Columns
- `id`, `tag_name` — the tag (e.g. python, sql).
- `count` — number of questions tagged with it.
- `excerpt_post_id`, `wiki_post_id` — the tag's wiki excerpt / wiki posts.

## Relationships (documented from this table)
- A question's `tags` field carries tag names corresponding to rows here.

---
*Source: SEDE Tags — factual.*
