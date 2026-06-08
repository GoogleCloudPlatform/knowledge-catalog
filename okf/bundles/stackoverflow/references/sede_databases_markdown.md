---
type: Reference
resource: https://meta.stackexchange.com/questions/2677/database-schema-documentation-for-the-public-data-dump-and-sede
title: SEDE Databases Markdown
description: Describes a SEDE internal table containing markdown content for database
  information.
tags:
- SEDE
- internal
- markdown
- schema
- data dump
timestamp: '2026-05-28T23:36:16+00:00'
---

This internal SEDE table contains markdown content related to database information, likely for display purposes.

## Schema
- `rn` (INTEGER) - Row number, used for sorting by the \'long name\' of the database.
- `content` (STRING) - Markdown content, potentially including headers, for database descriptions.

# Citations
- [Database schema documentation for the public data dump and SEDE](https://meta.stackexchange.com/questions/2677/database-schema-documentation-for-the-public-data-dump-and-sede)
