---
type: Reference
resource: https://meta.stackexchange.com/questions/2677/database-schema-documentation-for-the-public-data-dump-and-sede
title: SEDE Sites
description: Details the structure of the internal SEDE sites metadata table.
tags:
- SEDE
- internal
- sites
- schema
- data dump
timestamp: '2026-05-28T23:36:26+00:00'
---

This internal table in the Stack Exchange Data Explorer (SEDE) provides metadata about each Stack Exchange site.

## Schema
- `site_name` (STRING) - The short name of the site.
- `site_url` (STRING) - The base URL of the Stack Exchange site.
- `database_name` (STRING) - The name of the corresponding database in SEDE.
- `long_name` (STRING) - The full name of the site.
- `site_id` (INTEGER) - Unique identifier for the site.

# Citations
- [Database schema documentation for the public data dump and SEDE](https://meta.stackexchange.com/questions/2677/database-schema-documentation-for-the-public-data-dump-and-sede)
