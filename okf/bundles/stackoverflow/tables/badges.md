---
type: BigQuery Table
resource: https://bigquery.googleapis.com/v2/projects/bigquery-public-data/datasets/stackoverflow/tables/badges
title: Badges
description: This table contains information about badges awarded to users on the
  Stack Overflow platform, including details about the badge name, class, and whether
  it is tag-based.
tags:
- stackoverflow
- badges
- users
- awards
- schema
- data dump
timestamp: '2026-05-28T23:32:46+00:00'
---

The `badges` table records all badges awarded to users on the Stack Overflow Q&A platform. Each row represents a single badge awarded, detailing its unique identifier, name, the date it was awarded, the ID of the user who received it, its class (e.g., gold, silver, bronze), and whether it is a tag-based badge. The data spans from October 26, 2016, up to November 24, 2022. This table can be joined with the [users](users.md) table on `user_id` to get more information about the badge recipients.

# Schema

- `id` (INTEGER) - Unique identifier for the badge award.
- `name` (STRING) - Name of the badge.
- `date` (TIMESTAMP) - Timestamp when the badge was awarded (e.g., `2008-09-15T08:55:03.923`).
- `user_id` (INTEGER) - Identifier of the user who received the badge.
- `class` (INTEGER) - The class of the badge. See the [Badge Classes reference](../references/badge_classes.md) for possible values.
- `tag_based` (BOOLEAN) - `True` if the badge is for a tag, otherwise it is a named badge.

# Common query patterns

```sql
SELECT
    name,
    COUNT(*) AS badge_count
  FROM
    `bigquery-public-data.stackoverflow.badges`
  GROUP BY
    name
  ORDER BY
    badge_count DESC
  LIMIT 5;
```

```sql
SELECT
    b.name,
    b.date
  FROM
    `bigquery-public-data.stackoverflow.badges` AS b
    JOIN `bigquery-public-data.stackoverflow.users` AS u ON b.user_id = u.id
  WHERE
    u.display_name = \'Jon Skeet\'
  ORDER BY
    b.date DESC;
```

```sql
SELECT
    DATE(date) AS award_date,
    COUNT(*) AS badges_awarded
  FROM
    `bigquery-public-data.stackoverflow.badges`
  GROUP BY
    award_date
  ORDER BY
    award_date DESC
  LIMIT 10;
```

# Citations

[1] [BigQuery Public Data: stackoverflow.badges](https://bigquery.googleapis.com/v2/projects/bigquery-public-data/datasets/stackoverflow/tables/badges)
[2] [Stack Overflow](https://stackoverflow.com/)
[3] [Database schema documentation for the public data dump and SEDE](https://meta.stackexchange.com/questions/2677/database-schema-documentation-for-the-public-data-dump-and-sede)
